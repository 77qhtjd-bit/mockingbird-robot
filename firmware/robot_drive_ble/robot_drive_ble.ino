// Mockingbird robot drive, Arduino UNO R4 WiFi, Bluetooth LE.
//
// The phone (web/index.html in Bluefy / Chrome, Web Bluetooth) decides where to go and writes
// wheel speeds; this sketch only turns them into motor driver signals.
//
// Command characteristic (write / write without response), 4 bytes:
//   [seq lo, seq hi, left, right]   left/right = int8 speed in percent, -100..100 (+ = forward)
// ACK characteristic (notify), 2 bytes: the seq echoed back (round-trip time on the page).
// Watchdog: no command for WATCHDOG_MS, or the phone disconnects -> both motors stop.
// Height characteristic (write / write without response), 1 byte: 0..100 = screen lift position,
//   0 = lowest (children), 100 = highest (adults). The servo is not powered until the first
//   value arrives, so it does not jump at power-on; after that it holds its position, also when
//   the phone disconnects.
//
// Wiring (2-channel driver with AIN1/AIN2/BIN1/BIN2 inputs, e.g. DRV8833):
//   right TT motor  -> A01, A02     AIN1 -> D2, AIN2 -> D3 (PWM)
//   left  TT motor  -> B01, B02     BIN1 -> D4, BIN2 -> D5 (PWM)
//   D6 height servo (signal). Power the servo from the battery side, not from the R4's 5V pin.
//   D7 tilt servo: reserved, not driven by this sketch yet.
//   D8 direction pointer servo (signal): points where the robot is going (see POINT_* settings).
//
// Speed control with one PWM pin per motor (D2/D4 have no PWM on the R4):
//   forward : IN1 = HIGH, IN2 = PWM(255 - duty)   (drive / brake, slow decay)
//   reverse : IN1 = LOW,  IN2 = PWM(duty)         (drive / coast)
//   stop    : IN1 = LOW,  IN2 = LOW               (coast)
//
// Serial test without the phone (Serial Monitor 9600, "No line ending"):
//   w forward, s back, a spin left, d spin right, l left motor only, r right motor only, space stop.
//   Each key drives for SERIAL_HOLD_MS. Use it to check wiring and motor directions.
//   u screen up 10 %, j screen down 10 %.
//   1..9 set the test speed to 10..90 %, 0 sets 100 % (default 60 %).
//
// LED matrix: dotted bottom row = advertising; dotted top + bottom = connected, no command;
//   left bar (columns 1-2) = left wheel, right bar (columns 9-10) = right wheel,
//   up from the middle = forward, down = reverse, length = speed.

#include <ArduinoBLE.h>
#include <Servo.h>
#include "Arduino_LED_Matrix.h"

// ---------- Settings ----------
const int R_IN1 = 2;   // AIN1
const int R_IN2 = 3;   // AIN2 (PWM)
const int L_IN1 = 4;   // BIN1
const int L_IN2 = 5;   // BIN2 (PWM)
// A motor wired the other way round turns backwards on "forward". Set true to flip it in software
// instead of swapping its two wires on the driver.
const bool LEFT_REVERSED = false;
const bool RIGHT_REVERSED = true;
// Balance the wheels: duty scale in percent. If the robot curves when driving straight, lower the
// stronger side (the weaker side cannot go above full power). Curves left -> lower RIGHT_GAIN_PCT.
const int LEFT_GAIN_PCT = 100;
const int RIGHT_GAIN_PCT = 92;

// TT motors do not turn below a minimum duty. Any non-zero command is mapped to MIN_DUTY..255.
// Raise it if a wheel hums but does not turn at low speed; lower it if slow speeds are too fast.
const int MIN_DUTY = 90;
// Acceleration limit: duty change per RAMP_STEP_MS (255 / 8 per 5 ms = full speed in ~160 ms).
const int RAMP_STEP = 8;
const unsigned long RAMP_STEP_MS = 5;
const unsigned long WATCHDOG_MS = 400;
const unsigned long SERIAL_HOLD_MS = 700;
int serialTestSpeed = 60;   // percent; change it from the Serial Monitor with the digit keys

// Screen lift: a standard (positional) hobby servo on D6.
// Set the two angles to the ends of your mechanism's travel; swap them if up and down are reversed.
const int HEIGHT_PIN = 6;
const int HEIGHT_LOW_ANGLE = 160;   // servo angle with the screen at its lowest (0 %)
const int HEIGHT_HIGH_ANGLE = 20;   // servo angle with the screen at its highest (100 %)
// Slow travel so the phone is not jerked: 1 degree per HEIGHT_STEP_MS (20 ms = 50 degrees per second).
const unsigned long HEIGHT_STEP_MS = 20;

// Direction pointer: a standard hobby servo on D8 that points where the robot is going.
// It follows the wheel commands, so manual driving, Auto mode and the serial test keys all move it.
//   straight ahead (or stopped) -> POINT_CENTER_ANGLE
//   turning right               -> toward POINT_RIGHT_ANGLE (reached when spinning in place)
//   turning left                -> toward POINT_LEFT_ANGLE
// Adjust the three angles to your mount; if it points the wrong way, swap LEFT and RIGHT.
const int POINT_PIN = 8;
const int POINT_CENTER_ANGLE = 90;
const int POINT_LEFT_ANGLE = 170;
const int POINT_RIGHT_ANGLE = 10;
// Travel speed: POINT_STEP degrees per POINT_STEP_MS (3 per 20 ms = 150 degrees per second).
const int POINT_STEP = 3;
const unsigned long POINT_STEP_MS = 20;
// Stopped for this long -> return to center (short stops, e.g. while searching, keep the direction).
const unsigned long POINT_CENTER_AFTER_MS = 1500;
// Once the pointer has reached its angle, stop sending pulses after this long. The pointer carries
// no load, so it stays where it is, and without pulses it cannot jitter from motor noise.
// Long enough for the servo to physically get there on a weak battery.
const unsigned long POINT_RELEASE_MS = 1000;

#define SERVICE_UUID "c5831c08-81a7-4b41-bc27-ce21e6c8a9d0"
#define CMD_UUID     "ae8acab1-0450-4513-b4e1-0cec81b012a7"
#define ACK_UUID     "d55045a0-f292-446c-99f6-c6b81a18cba1"
#define HEIGHT_UUID  "535aa1fd-354f-456e-a5d3-7529c36fed04"
const int CMD_LEN = 4;

BLEService driveService(SERVICE_UUID);
BLECharacteristic cmdChar(CMD_UUID, BLEWrite | BLEWriteWithoutResponse, CMD_LEN, true);
BLECharacteristic ackChar(ACK_UUID, BLENotify, 2, true);
BLECharacteristic heightChar(HEIGHT_UUID, BLEWrite | BLEWriteWithoutResponse, 1, true);

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

Servo heightServo;
bool heightAttached = false;
int heightPct = 50;       // last requested position, 0..100
int heightAngle = 0;      // where the servo is now
int heightTarget = 0;     // where it is going
unsigned long lastHeightMs = 0;

Servo pointServo;
int cmdPct[2] = {0, 0};   // last wheel command in percent [left, right], 0 when stopped
int pointAngle = POINT_CENTER_ANGLE;
int pointTarget = POINT_CENTER_ANGLE;
unsigned long lastPointMs = 0;
unsigned long lastMovingMs = 0;
bool pointAttached = false;

// ---------- Motors ----------
int percentToDuty(int pct, int gainPct) {
  pct = constrain(pct, -100, 100);
  if (pct == 0) return 0;
  int mag = MIN_DUTY + (long)(255 - MIN_DUTY) * abs(pct) / 100;
  mag = constrain((long)mag * gainPct / 100, 0, 255);
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
  writeMotor(L_IN1, L_IN2, LEFT_REVERSED ? -duty[0] : duty[0]);
  writeMotor(R_IN1, R_IN2, RIGHT_REVERSED ? -duty[1] : duty[1]);
}

void stopNow() {
  cmdPct[0] = cmdPct[1] = 0;
  targetDuty[0] = targetDuty[1] = 0;
  duty[0] = duty[1] = 0;
  applyMotors();
  matrixDirty = true;
}

void setTargets(int leftPct, int rightPct, unsigned long hold) {
  cmdPct[0] = constrain(leftPct, -100, 100);
  cmdPct[1] = constrain(rightPct, -100, 100);
  targetDuty[0] = percentToDuty(leftPct, LEFT_GAIN_PCT);
  targetDuty[1] = percentToDuty(rightPct, RIGHT_GAIN_PCT);
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

// ---------- Screen lift ----------
void setHeight(int pct) {
  heightPct = constrain(pct, 0, 100);
  heightTarget = map(heightPct, 0, 100, HEIGHT_LOW_ANGLE, HEIGHT_HIGH_ANGLE);
  if (!heightAttached) {
    // First value since power-on: the phone sends the position it remembers, which is where
    // the lift was left, so start there instead of sweeping from an unknown angle.
    heightAngle = heightTarget;
    heightServo.attach(HEIGHT_PIN);
    heightServo.write(heightAngle);
    heightAttached = true;
  }
}

void updateHeight() {
  if (!heightAttached || heightAngle == heightTarget) return;
  unsigned long now = millis();
  if (now - lastHeightMs < HEIGHT_STEP_MS) return;
  lastHeightMs = now;
  heightAngle += heightTarget > heightAngle ? 1 : -1;
  heightServo.write(heightAngle);
}

// ---------- Direction pointer ----------
// Heading from the wheel command: forward part = (left + right) / 2, turn part = (left - right) / 2.
// atan2(turn, |forward|) is 0 straight ahead and +-90 degrees when spinning in place.
// Reversing uses |forward|, so the pointer shows the steering side, not "backwards".
void updatePointer() {
  unsigned long now = millis();
  int l = cmdPct[0], r = cmdPct[1];
  if (l != 0 || r != 0) {
    lastMovingMs = now;
    float fwd = (l + r) * 0.5f;
    float turn = (l - r) * 0.5f;
    float deg = atan2(turn, fabs(fwd)) * 180.0f / PI;   // -90 (left) .. +90 (right)
    if (deg >= 0) pointTarget = POINT_CENTER_ANGLE + (int)((POINT_RIGHT_ANGLE - POINT_CENTER_ANGLE) * deg / 90.0f);
    else pointTarget = POINT_CENTER_ANGLE + (int)((POINT_CENTER_ANGLE - POINT_LEFT_ANGLE) * deg / 90.0f);
  } else if (now - lastMovingMs > POINT_CENTER_AFTER_MS) {
    pointTarget = POINT_CENTER_ANGLE;
  }

  if (pointAngle == pointTarget) {
    if (pointAttached && now - lastPointMs > POINT_RELEASE_MS) {
      pointServo.detach();
      pointAttached = false;
      Serial.print("pointer: holding at ");
      Serial.println(pointAngle);
    }
    return;
  }
  if (now - lastPointMs < POINT_STEP_MS) return;
  lastPointMs = now;
  pointAngle += constrain(pointTarget - pointAngle, -POINT_STEP, POINT_STEP);
  if (!pointAttached) {
    pointAttached = pointServo.attach(POINT_PIN) != 0;
    Serial.print(pointAttached ? "pointer: moving toward " : "pointer: ERROR attach failed, target ");
    Serial.println(pointTarget);
  }
  pointServo.write(pointAngle);
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
    if (c >= '0' && c <= '9') {
      // Test speed: 1..9 = 10..90 %, 0 = 100 % (no PWM chopping, the motor gets steady full voltage).
      serialTestSpeed = c == '0' ? 100 : (c - '0') * 10;
      Serial.print("test speed ");
      Serial.print(serialTestSpeed);
      Serial.println("%");
      continue;
    }
    int s = serialTestSpeed;
    switch (c) {
      case 'w': l = s; r = s; break;
      case 's': l = -s; r = -s; break;
      case 'a': l = -s; r = s; break;
      case 'd': l = s; r = -s; break;
      case 'l': l = s; break;
      case 'r': r = s; break;
      case ' ': signalLost(); Serial.println("stop"); continue;
      case 'u':
      case 'j':
        setHeight(heightPct + (c == 'u' ? 10 : -10));
        Serial.print("screen height ");
        Serial.print(heightPct);
        Serial.println("%");
        continue;
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
  // Hold the servo signal lines low until a servo is attached. A floating signal pin picks up
  // noise and makes an SG90 buzz or twitch as soon as its power comes on.
  pinMode(HEIGHT_PIN, OUTPUT);
  digitalWrite(HEIGHT_PIN, LOW);
  pinMode(7, OUTPUT);   // tilt servo, not driven yet
  digitalWrite(7, LOW);
  pointServo.attach(POINT_PIN);
  pointServo.write(POINT_CENTER_ANGLE);
  pointAttached = true;
  lastPointMs = millis();   // released POINT_RELEASE_MS after this, once it has reached center
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
    driveService.addCharacteristic(heightChar);
    BLE.addService(driveService);
    BLE.setEventHandler(BLEConnected, onConnect);
    BLE.setEventHandler(BLEDisconnected, onDisconnect);
    BLE.advertise();
    Serial.println("Advertising as MockingbirdBot");
  }
  Serial.println("Pins: right AIN1 D2, AIN2 D3 | left BIN1 D4, BIN2 D5 | height servo D6 | pointer servo D8");
  Serial.println("Serial test: w/s/a/d, l = left only, r = right only, space = stop, u/j = screen up/down, 1-9/0 = test speed 10-90/100 %");
}

void loop() {
  if (bleOk) {
    BLE.poll();
    if (cmdChar.written() && cmdChar.valueLength() == CMD_LEN) {
      const uint8_t *v = cmdChar.value();
      ackChar.writeValue(v, 2);   // echo seq first
      setTargets((int8_t)v[2], (int8_t)v[3], WATCHDOG_MS);
    }
    if (heightChar.written() && heightChar.valueLength() == 1) setHeight(heightChar.value()[0]);
  }
  handleSerial();

  if (haveSignal && millis() - lastCmdMs > holdMs) {
    signalLost();
    if (holdMs == WATCHDOG_MS) Serial.println("Watchdog: no command, motors stopped");
  }

  updateRamp();
  updateHeight();
  updatePointer();
  if (matrixDirty) drawMatrix();
}
