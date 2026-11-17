// Digital-only motor test (Arduino UNO R4 WiFi + DRV8833).
//
// No PWM, no Serial, no Bluetooth, no LED matrix, no servo.
// Repeats forever: D2 = HIGH, D3 = LOW for 1 second (motor should run forward at full speed),
// then both LOW for 3 seconds (motor stopped).
// The on-board LED "L" (D13) is on exactly while the motor should be running.
//
// Wiring: AIN1 -> D2, AIN2 -> D3 (no wire from AIN1/AIN2 to 5V or to the battery),
//         motor on AO1/AO2, VM and STBY -> battery +, driver GND -> battery - and Arduino GND.

const int IN1 = 2;   // AIN1
const int IN2 = 3;   // AIN2

void setup() {
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(LED_BUILTIN, LOW);
  delay(3000);   // time to check that the power bank is on
}

void loop() {
  digitalWrite(IN2, LOW);
  digitalWrite(IN1, HIGH);
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);

  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(LED_BUILTIN, LOW);
  delay(3000);
}
