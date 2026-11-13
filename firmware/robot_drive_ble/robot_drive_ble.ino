// Mockingbird robot drive, Arduino UNO R4 WiFi, Bluetooth LE.
//
// The phone (web/index.html in Bluefy / Chrome, Web Bluetooth) decides where to go and writes
// wheel speeds; this sketch only turns them into motor driver signals.
//
// Command characteristic (write / write without response), 4 bytes:
//   [seq lo, seq hi, left, right]   left/right = int8 speed in percent, -100..100 (+ = forward)
// ACK characteristic (notify), 2 bytes: the seq echoed back (round-trip time on the page).
// Watchdog: no command for WATCHDOG_MS, or the phone disconnects -> both motors stop.
//
// Wiring (2-channel driver with AIN1/AIN2/BIN1/BIN2 inputs, e.g. DRV8833):
//   right TT motor  -> A01, A02     AIN1 -> D2, AIN2 -> D3 (PWM)
//   left  TT motor  -> B01, B02     BIN1 -> D4, BIN2 -> D5 (PWM)
//   D6 height servo, D7 tilt servo: reserved, not driven by this sketch yet.
//
// Speed control with one PWM pin per motor (D2/D4 have no PWM on the R4):
//   forward : IN1 = HIGH, IN2 = PWM(255 - duty)   (drive / brake, slow decay)
//   reverse : IN1 = LOW,  IN2 = PWM(duty)         (drive / coast)
//   stop    : IN1 = LOW,  IN2 = LOW               (coast)
//
// Serial test without the phone (Serial Monitor 9600, "No line ending"):
//   w forward, s back, a spin left, d spin right, l left motor only, r right motor only, space stop.
//   Each key drives for SERIAL_HOLD_MS. Use it to check wiring and motor directions.
//
// LED matrix: dotted bottom row = advertising; dotted top + bottom = connected, no command;
//   left bar (columns 1-2) = left wheel, right bar (columns 9-10) = right wheel,
//   up from the middle = forward, down = reverse, length = speed.

#include <ArduinoBLE.h>
#include "Arduino_LED_Matrix.h"

// ---------- Settings ----------
const int R_IN1 = 2;   // AIN1
const int R_IN2 = 3;   // AIN2 (PWM)
const int L_IN1 = 4;   // BIN1
const int L_IN2 = 5;   // BIN2 (PWM)

// TT motors do not turn below a minimum duty. Any non-zero command is mapped to MIN_DUTY..255.
// Raise it if a wheel hums but does not turn at low speed; lower it if slow speeds are too fast.
const int MIN_DUTY = 90;
// Acceleration limit: duty change per RAMP_STEP_MS (255 / 8 per 5 ms = full speed in ~160 ms).
const int RAMP_STEP = 8;
const unsigned long RAMP_STEP_MS = 5;
const unsigned long WATCHDOG_MS = 400;
const unsigned long SERIAL_HOLD_MS = 700;
const int SERIAL_TEST_SPEED = 60;   // percent

#define SERVICE_UUID "c5831c08-81a7-4b41-bc27-ce21e6c8a9d0"
#define CMD_UUID     "ae8acab1-0450-4513-b4e1-0cec81b012a7"
#define ACK_UUID     "d55045a0-f292-446c-99f6-c6b81a18cba1"
const int CMD_LEN = 4;

BLEService driveService(SERVICE_UUID);
BLECharacteristic cmdChar(CMD_UUID, BLEWrite | BLEWriteWithoutResponse, CMD_LEN, true);
BLECharacteristic ackChar(ACK_UUID, BLENotify, 2, true);

ArduinoLEDMatrix matrix;
uint8_t frame[8][12];

int targetDuty[2] = {0, 0};   // [left, right], -255..255
int duty[2] = {0, 0};         // applied, ramps toward targetDuty
unsigned long lastCmdMs = 0;
unsigned long holdMs = WATCHDOG_MS;
unsigned long lastRampMs = 0;
bool haveSignal = false;
bool connected = false;
bool bleOk = false;
bool matrixDirty = true;

// ---------- Motors ----------
int percentToDuty(int pct) {
  pct = constrain(pct, -100, 100);
  if (pct == 0) return 0;
  int mag = MIN_DUTY + (long)(255 - MIN_DUTY) * abs(pct) / 100;
  return pct > 0 ? mag : -mag;
}

void writeMotor(int in1, int in2, int d) {
  if (d > 0) {
    digitalWrite(in1, HIGH);
    analogWrite(in2, 255 - d);
  } else if (d < 0) {
    digitalWrite(in1, LOW);
    analogWrite(in2, -d);
  } else {
    digitalWrite(in1, LOW);
    analogWrite(in2, 0);
  }
}

void applyMotors() {
  writeMotor(L_IN1, L_IN2, duty[0]);
  writeMotor(R_IN1, R_IN2, duty[1]);
}

void stopNow() {
  targetDuty[0] = targetDuty[1] = 0;
  duty[0] = duty[1] = 0;
  applyMotors();
  matrixDirty = true;
}

void setTargets(int leftPct, int rightPct, unsigned long hold) {
  targetDuty[0] = percentToDuty(leftPct);
  targetDuty[1] = percentToDuty(rightPct);
  lastCmdMs = millis();
  holdMs = hold;
  if (!haveSignal) matrixDirty = true;
  haveSignal = true;
}

// Move the applied duty toward the target. Crossing zero (direction change) also ramps,
// which protects the gearbox; stops from the watchdog skip the ramp (stopNow).
void updateRamp() {
  unsigned long now = millis();
  if (now - lastRampMs < RAMP_STEP_MS) return;
  lastRampMs = now;
  bool changed = false;
  for (int i = 0; i < 2; i++) {
    int d = duty[i], t = targetDuty[i];
    if (d == t) continue;
    // Below MIN_DUTY the motor does not move, so jump across that band instead of ramping through it.
    if (t != 0 && (d == 0 || (d > 0) != (t > 0))) {
      d = d == 0 ? (t > 0 ? MIN_DUTY : -MIN_DUTY) : 0;
    } else if (t == 0 && abs(d) <= MIN_DUTY) {
      d = 0;
    } else {
      d += constrain(t - d, -RAMP_STEP, RAMP_STEP);
    }
    duty[i] = d;
    changed = true;
  }
  if (changed) {
    applyMotors();
    matrixDirty = true;
  }
}

// ---------- LED matrix ----------
void drawBar(int col, int d) {
  int len = (abs(d) * 4 + 254) / 255;   // 0..4 rows
  for (int k = 0; k < len; k++) {
    int r = d > 0 ? 3 - k : 4 + k;
    frame[r][col] = 1;
    frame[r][col + 1] = 1;
  }
}

void drawMatrix() {
  memset(frame, 0, sizeof(frame));
  if (!haveSignal) {
    for (int c = 0; c < 12; c += 2) {
      frame[7][c] = 1;
      if (connected) frame[0][c] = 1;
    }
  } else {
    drawBar(1, duty[0]);
    drawBar(9, duty[1]);
    frame[3][5] = frame[4][6] = 1;   // small mark in the middle: signal OK
  }
  matrix.renderBitmap(frame, 8, 12);
  matrixDirty = false;
}

// ---------- BLE events ----------
void signalLost() {
  haveSignal = false;
  stopNow();
}

void onConnect(BLEDevice central) {
  connected = true;
  Serial.print("Connected: ");
  Serial.println(central.address());
  signalLost();
}

void onDisconnect(BLEDevice central) {
  connected = false;
  Serial.println("Disconnected, motors stopped");
  signalLost();
  BLE.advertise();
}

// ---------- Serial test ----------
void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    int l = 0, r = 0;
    int s = SERIAL_TEST_SPEED;
    switch (c) {
      case 'w': l = s; r = s; break;
      case 's': l = -s; r = -s; break;
      case 'a': l = -s; r = s; break;
      case 'd': l = s; r = -s; break;
      case 'l': l = s; break;
      case 'r': r = s; break;
      case ' ': signalLost(); Serial.println("stop"); continue;
      default: continue;
    }
    setTargets(l, r, SERIAL_HOLD_MS);
    Serial.print("serial test: left ");
    Serial.print(l);
    Serial.print("%, right ");
    Serial.print(r);
    Serial.println("%");
  }
}

// ---------- Main ----------
void setup() {
  Serial.begin(9600);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) {}

  pinMode(R_IN1, OUTPUT);
  pinMode(R_IN2, OUTPUT);
  pinMode(L_IN1, OUTPUT);
  pinMode(L_IN2, OUTPUT);
  stopNow();
  matrix.begin();
  drawMatrix();

  if (!BLE.begin()) {
    Serial.println("ERROR: BLE.begin() failed (update the WiFi/BLE module firmware?)");
    Serial.println("Serial test keys still work.");
  } else {
    bleOk = true;
    BLE.setLocalName("MockingbirdBot");
    BLE.setDeviceName("MockingbirdBot");
    BLE.setAdvertisedService(driveService);
    driveService.addCharacteristic(cmdChar);
    driveService.addCharacteristic(ackChar);
    BLE.addService(driveService);
    BLE.setEventHandler(BLEConnected, onConnect);
    BLE.setEventHandler(BLEDisconnected, onDisconnect);
    BLE.advertise();
    Serial.println("Advertising as MockingbirdBot");
  }
  Serial.println("Pins: right AIN1 D2, AIN2 D3 | left BIN1 D4, BIN2 D5");
  Serial.println("Serial test: w/s/a/d, l = left only, r = right only, space = stop");
}

void loop() {
  if (bleOk) {
    BLE.poll();
    if (cmdChar.written() && cmdChar.valueLength() == CMD_LEN) {
      const uint8_t *v = cmdChar.value();
      ackChar.writeValue(v, 2);   // echo seq first
      setTargets((int8_t)v[2], (int8_t)v[3], WATCHDOG_MS);
    }
  }
  handleSerial();

  if (haveSignal && millis() - lastCmdMs > holdMs) {
    signalLost();
    if (holdMs == WATCHDOG_MS) Serial.println("Watchdog: no command, motors stopped");
  }

  updateRamp();
  if (matrixDirty) drawMatrix();
}
