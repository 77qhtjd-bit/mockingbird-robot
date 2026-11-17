// Motor pin test for the Mockingbird robot (Arduino UNO R4 WiFi + DRV8833).
//
// No Bluetooth, no LED matrix, no servo, no keys to type: the sketch runs a fixed sequence over
// and over and prints each step to the Serial Monitor (9600). Watch the right motor and note
// which steps turn it.
//
// Wiring: AIN1 -> D2, AIN2 -> D3, motor on AO1/AO2, VM and STBY -> battery +,
//         driver GND -> battery - and Arduino GND.
//
// Steps 1-2 use plain digital outputs (no PWM). Steps 3-8 use PWM on D3.

const int IN1 = 2;
const int IN2 = 3;   // PWM
const unsigned long RUN_MS = 2000;
const unsigned long PAUSE_MS = 1500;

void pauseStep() {
  pinMode(IN2, OUTPUT);        // back to a plain digital pin after any PWM
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  delay(PAUSE_MS);
}

void digitalStep(int n, const char *name, int in1, int in2) {
  Serial.print("Step ");
  Serial.print(n);
  Serial.print(": ");
  Serial.println(name);
  pinMode(IN2, OUTPUT);
  digitalWrite(IN1, in1);
  digitalWrite(IN2, in2);
  delay(RUN_MS);
  pauseStep();
}

void pwmStep(int n, const char *name, int in1, int pwm) {
  Serial.print("Step ");
  Serial.print(n);
  Serial.print(": ");
  Serial.print(name);
  Serial.print("  (D2 ");
  Serial.print(in1 == HIGH ? "HIGH" : "LOW");
  Serial.print(", D3 PWM ");
  Serial.print(pwm);
  Serial.println("/255)");
  digitalWrite(IN1, in1);
  analogWrite(IN2, pwm);
  delay(RUN_MS);
  pauseStep();
}

void setup() {
  Serial.begin(9600);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) {}
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  Serial.println("Motor pin test: AIN1 = D2, AIN2 = D3. Each step runs 2 s.");
}

void loop() {
  Serial.println("---- start (check that the power bank is on) ----");
  delay(2000);
  digitalStep(1, "digital forward, full speed", HIGH, LOW);
  digitalStep(2, "digital reverse, full speed", LOW, HIGH);
  pwmStep(3, "PWM forward 100 %", HIGH, 0);
  pwmStep(4, "PWM forward  80 %", HIGH, 51);
  pwmStep(5, "PWM forward  60 %", HIGH, 102);
  pwmStep(6, "PWM reverse 100 %", LOW, 255);
  pwmStep(7, "PWM reverse  80 %", LOW, 204);
  pwmStep(8, "PWM reverse  60 %", LOW, 153);
}
