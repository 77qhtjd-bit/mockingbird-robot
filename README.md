# Mockingbird Robot: 사람을 만나 말을 거는 로봇

로봇 위에 올린 휴대폰이 카메라로 **사람(회색 사람 모형, Bambu Lab PLA Basic – Gray)** 을 찾습니다.
서 있는 사람에게는 다가가 영어로 말을 걸고, 반응이 없으면 몇 초 뒤 지나갑니다. 걷는 사람은 따라가지 않고,
가까워지면 멈춥니다. 누군가 화면을 쓰는 동안에는 움직이지 않습니다.
같은 웹페이지에서 **수동 조종**(조이스틱/키보드)과 **화면 높이 조절**(D6 서보)도 할 수 있습니다.
기울기 서보(D7)는 아직 쓰지 않습니다.

구조는 [haptic-lane-guide](https://github.com/77qhtjd-bit/haptic-lane-guide)와 같습니다.
계산은 모두 휴대폰 브라우저에서 하고, 아두이노는 받은 바퀴 속도대로 모터만 돌립니다.

```
휴대폰 브라우저 (로봇 앞쪽에 화면이 정면을 보게 고정, 전면 카메라)                  Arduino UNO R4 WiFi
카메라 640x480 → 160px로 축소 → 회색 영역 찾기 → 행동 상태기계 → 좌/우 속도 ──BLE──> 모터 드라이버 → TT 모터 2개
                                                  화면 높이(0~100%) ──BLE──> 높이 서보 (D6)
                                                                    <── ACK ───  400 ms 동안 명령 없으면 정지
```

| 파일 | 내용 |
|---|---|
| `web/index.html` | 앱 화면: 로봇 연결, 카메라, **Auto**(사람 만나기) / **Manual**(직접 조종), 화면 높이, 음성 |
| `web/js/vision.js` | 회색 모형 검출 (색 마스크 → 덩어리 → 모양·크기 점수) |
| `web/js/follow.js` | 찾기 → 지켜보기 → 다가가기 → 인사 → 지나가기 상태기계, 수동 조종 계산 |
| `web/js/robot-link.js` | Web Bluetooth 연결 (자동 재연결, 지연 시간 측정, 화면 높이 전송) |
| `firmware/robot_drive_ble/` | R4 WiFi 스케치 (BLE 수신, 모터 구동, 높이 서보, 워치독, 시리얼 테스트) |
| `web/test/` | 검출·제어·패킷 단위 테스트 (`npm test`) |

## 전체 시스템 구성

Mockingbird는 레포 두 개, 배포 두 곳, 서버 하나로 이루어져 있습니다.

```
로봇 휴대폰 (Bluefy, 로봇 앱 = GitHub Pages)
 ├─ 화면 ── Vercel 첫 화면(그림 보기 / 그리기 선택)을 전체 화면으로 표시
 │           ├─ 그림 제출·이모지 반응 ──▶ Supabase (그림·메모·반응 저장)
 │           └─ "화면을 쓰는 중" 신호 ──▶ 로봇 정지
 ├─ 스피커 ── 영어 음성으로 말 걸기
 ├─ 전면 카메라 ── 사람(회색 모형) 찾기, 서 있는지 걷는지, 얼마나 가까운지 판단
 └─ 블루투스 ── Arduino UNO R4 WiFi ─┬─ 모터 드라이버 ── 바퀴 2개
                                      └─ 높이 서보 (D6) ── 휴대폰 화면 위아래

관람객 휴대폰 ── 모자이크의 QR ── Vercel 첫 화면 ── 그림 제출·반응 ──▶ Supabase

큰 모니터 ── Vercel /mosaic ◀── 5초마다 새 그림 조회 ── Supabase
```

| 구성 요소 | 레포 | 배포 위치 | 역할 |
|---|---|---|---|
| 로봇 앱 | [`mockingbird-robot`](https://github.com/77qhtjd-bit/mockingbird-robot) | GitHub Pages: https://77qhtjd-bit.github.io/mockingbird-robot/web/ | 카메라로 사람 찾기, 바퀴 제어, 말 걸기, 관람객 화면 띄우기, 화면을 쓰는 동안 정지, 화면 높이 |
| 아두이노 스케치 | `mockingbird-robot` (`firmware/`) | R4 WiFi에 직접 업로드 | 받은 바퀴 속도로 모터 구동, 높이 서보 구동, 신호 끊기면 정지 |
| 관람객 화면 `/`, `/draw`, `/gallery` | [`mockingbird-mosaic`](https://github.com/77qhtjd-bit/mockingbird-mosaic) | Vercel: https://mockingbird-mosaic.vercel.app/ | 로봇 소개, 그림·메모 제출, 다른 사람 그림 보기와 이모지 반응. 로봇 앱 안에서는 "화면을 쓰는 중" 신호를 보냄 |
| 모자이크 `/mosaic` | `mockingbird-mosaic` | Vercel: https://mockingbird-mosaic.vercel.app/mosaic | 모인 그림으로 포토모자이크, 감동 문구, QR 코드 |
| 데이터 | — | Supabase | 그림 이미지(Storage)와 메모(DB) 저장 |

**무엇을 고치면 어디에 반영되나**
- 그림 페이지나 모자이크를 바꾸려면 `mockingbird-mosaic`에 푸시합니다. Vercel이 자동 배포하고, 로봇 화면에도 바로 반영됩니다.
- 로봇 동작(찾기, 주행, 말 걸기, 화면 띄우기)을 바꾸려면 `mockingbird-robot`의 `web/`을 고쳐 푸시합니다. 1분 안에 GitHub Pages에 반영됩니다.
- 모터 핀, 최소 출력, 정지 시간, 높이 서보 각도를 바꾸려면 `firmware/` 스케치를 고치고 Arduino IDE로 다시 업로드합니다.

**행사 당일 순서**
1. 큰 모니터에서 `/mosaic`을 열고 **Fullscreen**을 누릅니다.
2. 로봇 전원을 켭니다. R4의 LED 매트릭스 아래 줄에 점선이 보이면 연결 대기 상태입니다.
3. 로봇 휴대폰에서 자동 잠금을 **안 함**으로 두고, Bluefy로 로봇 앱을 엽니다.
4. **Connect robot** → **Start camera** → **Calibrate**(모형 탭) → **Screen height**로 화면 높이를 맞춥니다.
5. **START**를 누릅니다. 로봇이 "Hello! I am Mockingbird."라고 말하고(소리 확인), 화면이 관람객용 첫 화면으로 바뀝니다.
6. 운영 화면으로 돌아가려면 왼쪽 위 점을 1초 누릅니다. 점 색은 초록 = 자동 동작 중, 주황 = 사람 앞에 멈춰 있음(인사 중이거나 화면을 쓰는 중), 회색 = 정지입니다.

## 1. 배선

| 장치 | 드라이버 연결 | R4 WiFi 핀 |
|---|---|---|
| 우측 TT 모터 | A01, A02 | — |
| 우측 모터 제어 | AIN1, AIN2 | **D2, D3** |
| 좌측 TT 모터 | B01, B02 | — |
| 좌측 모터 제어 | BIN1, BIN2 | **D4, D5** |
| 높이 조절 서보 | 신호선 | **D6** |
| 기울기 조절 서보 | — | D7 (아직 사용 안 함) |

- 드라이버는 AIN1/AIN2/BIN1/BIN2 입력 두 개로 방향과 속도를 정하는 방식(DRV8833 등)을 가정했습니다.
  R4에서 D2, D4는 PWM이 안 되므로 **D3, D5(PWM)로 속도를, D2, D4로 방향을** 정합니다.
- TB6612FNG처럼 PWMA/PWMB, STBY 핀이 따로 있는 드라이버라면 이 세 핀을 VCC(High)에 연결하세요. 그러면 같은 코드로 동작합니다.
- 모터 전원(배터리)은 드라이버 VM에, **드라이버 GND와 아두이노 GND는 반드시 연결**합니다.
- 높이 서보는 일반(각도 제어) 서보를 가정했습니다. 휴대폰 무게를 들어야 하므로 **서보 전원(5~6 V)은 R4의 5V 핀이 아니라
  배터리 쪽(BEC 등)에서** 가져오고, GND는 아두이노와 공유합니다. 연속 회전 서보라면 스케치를 바꿔야 합니다.

## 2. 아두이노 업로드

1. Arduino IDE 2 → Boards Manager에서 **Arduino UNO R4 Boards** 설치 → 보드 **Arduino UNO R4 WiFi** 선택.
2. Library Manager에서 **ArduinoBLE** 설치 (`Arduino_LED_Matrix`와 `Servo`는 기본 포함).
3. `firmware/robot_drive_ble/robot_drive_ble.ino`를 열고 Upload.
4. 시리얼 모니터(9600)에 `Advertising as MockingbirdBot`이 보이면 정상입니다.
   `BLE.begin() failed`가 나오면 **Tools → Firmware Updater**로 통신 모듈 펌웨어를 업데이트하세요.

**배선 확인 (휴대폰 없이)**: 시리얼 모니터 줄 끝을 *No line ending*으로 두고 키를 보냅니다.
`w` 전진, `s` 후진, `a` 왼쪽 제자리 회전, `d` 오른쪽 제자리 회전, `l` 왼쪽 바퀴만, `r` 오른쪽 바퀴만, 스페이스 정지.
각 키는 0.7초 동안만 돕니다. `w`에서 두 바퀴가 모두 앞으로 가는지 먼저 확인하세요.
`u` / `j`는 화면을 10%씩 올리고 내립니다. 기구가 끝에 닿기 전에 멈추도록 스케치의 `HEIGHT_LOW_ANGLE` / `HEIGHT_HIGH_ANGLE`
(화면이 가장 낮을 때와 높을 때의 서보 각도, 기본 20° / 160°)을 실제 기구에 맞게 고치세요. 위아래가 반대면 두 값을 바꿉니다.
방향이 반대인 바퀴는 모터 선 두 가닥을 바꾸거나, 웹 화면의 **Wheels & log → Reverse left/right wheel**을 켜면 됩니다.

LED 매트릭스: 아래 줄 점선 = 연결 대기, 위아래 점선 = 연결됨(명령 없음),
왼쪽/오른쪽 막대 = 각 바퀴 속도 (가운데에서 위로 = 전진, 아래로 = 후진).

## 3. 웹 앱 실행

카메라와 Bluetooth는 HTTPS에서만 동작해서 GitHub Pages로 올려 둡니다.
**앱 주소: https://77qhtjd-bit.github.io/mockingbird-robot/web/**

| 기기 | 브라우저 |
|---|---|
| iPhone | **Bluefy** 앱 (Safari는 Web Bluetooth 미지원) |
| Android | Chrome |
| 노트북 (수동 조종용) | Chrome / Edge |

### Auto: 사람 만나기
1. 휴대폰을 로봇 앞쪽에 **화면(전면 카메라)이 정면을 보도록** 고정합니다.
   후면 카메라를 쓰려면 **Camera & screen**에서 *Rear*를 고릅니다.
2. **Connect robot** → `MockingbirdBot` 선택 (한 번만 하면 이후 자동 재연결).
3. **Start camera**.
4. **Calibrate**를 누르고 화면에서 모형을 탭합니다. 지금 조명에서 모형이 보이는 회색이 기준색이 됩니다.
   파란색으로 칠해진 부분이 "회색으로 인식된 곳", 노란 상자가 "사람으로 고른 모형"입니다.
5. **START**. 이후 로봇은 아래처럼 행동합니다 (화면 왼쪽 위 글자와 **Wheels & log**에 현재 상태가 나옵니다).

| 상태 | 로봇이 하는 일 |
|---|---|
| Looking for people | 제자리에서 조금씩 돌며 사람을 찾습니다. 40초 동안 아무도 없으면 15초 쉬었다가 다시 찾습니다. |
| Someone in view — watching | 사람이 보이면 **일단 멈춰서** 약 1초 지켜봅니다. 로봇이 서 있으므로 화면에서 위치나 크기가 변하면 그 사람이 걷고 있는 것입니다. |
| Approaching | **서 있는 사람**이면 방향을 맞추며 다가가고, 화면 높이의 60%를 채우면 멈춥니다. |
| Walking person — not following | **걷는 사람**은 따라가지 않고 서서 지켜봅니다. 그 사람이 가까이 오면 그대로 인사하고, 멈춰 서면 다가갑니다. 8초 동안 가까워지지 않으면 다른 쪽을 찾습니다. |
| Said hello — waiting for a touch | 사람 앞에 멈춰 영어로 말을 겁니다("How are you? Draw your day!", "Could you show me your day briefly?" 등이 번갈아 나옴). 화면에도 같은 문장이 말풍선으로 뜹니다. |
| Screen in use — staying put | 누군가 화면을 만지면 **어떤 상태에서든 즉시 멈추고** 쓰는 동안 움직이지 않습니다. |
| No response — moving on | 인사 후 6초 동안 터치가 없거나, 화면을 다 쓰고 떠나면: 그 사람 반대쪽으로 돌아서 조금 전진한 뒤 다시 찾습니다. 전진 중에 다른 사람이 가까이 보이면 멈춰서 인사합니다. |

   초음파 같은 거리 센서가 없어서 **"가깝다"는 항상 "카메라 화면에서 사람이 크게 보인다"** 는 뜻입니다.
   같은 이유로 벽·테이블 끝은 알지 못합니다. 지나갈 때 전진하는 시간(*then drive on for*)을 장소에 맞게 줄이거나 0으로 두세요.
6. **STOP** 버튼이나 키보드 **스페이스**로 언제든 정지. 페이지를 벗어나거나 연결이 끊겨도 0.4초 안에 멈춥니다.
7. 로봇이 사람 반대쪽으로 돈다면 **Camera & screen → Flip image left/right**를 켭니다.

**음성**: 브라우저의 음성 합성(영어)을 씁니다. 휴대폰은 화면을 누른 직후에만 소리를 허용하므로, START를 누를 때 나오는
첫 인사가 이후 음성을 열어 줍니다. 휴대폰 무음 스위치와 볼륨을 확인하세요. **Settings → Test voice**로 미리 들어볼 수 있고,
*Speak to people*을 끄면 말풍선만 뜹니다. 그림을 제출하면 "Thank you! Have a nice day."라고 말합니다.

### 화면 높이 (수동)
어린이와 어른 모두 화면에 닿을 수 있도록 휴대폰·태블릿을 위아래로 움직입니다. Auto / Manual 어느 쪽에서든 쓸 수 있습니다.
- **▲ Raise / ▼ Lower**를 누르고 있으면 움직이고, 떼면 멈춥니다. 노트북에서는 **R / F** 키.
- **Child / Middle / Adult** 버튼은 미리 정한 높이(10% / 50% / 90%)로 바로 갑니다.
- 높이는 브라우저에 저장되고 다시 연결하면 보드에 다시 보내서, 서보가 그 자리를 유지합니다. 서보는 천천히 움직입니다(초당 50°).
- "needs the current firmware on the board"가 보이면 보드에 예전 스케치가 올라가 있는 것입니다. 2번의 방법으로 다시 업로드하세요
  (주행은 예전 스케치로도 됩니다).

### 휴대폰 화면에 관람객 화면 띄우기 (로봇은 계속 동작)
iPhone에서 Bluefy를 백그라운드로 보내거나 다른 탭으로 바꾸면 카메라와 스크립트가 멈추고, 로봇도 0.4초 안에 섭니다.
그래서 관람객 화면은 **앱 안에서** 화면 전체로 띄웁니다.

1. **START**를 누르면 관람객용 첫 화면(https://mockingbird-mosaic.vercel.app/)이 화면 전체에 자동으로 뜹니다
   (**Show visitor screen** 버튼으로도 띄울 수 있음). 사람들은 이 화면에서 다른 사람 그림을 보거나 바로 그림을 그려 제출할 수 있고,
   그 아래에서 카메라·검출·블루투스는 그대로 돌아갑니다. 카메라 화면은 보이지 않습니다.
2. 왼쪽 위의 작은 점: 초록 = 자동 동작 중, 주황 = 사람 앞에 멈춰 있음, 회색 = 정지. **점을 1초 누르고 있으면** 앱 화면으로 돌아옵니다.
3. 주소는 **Camera & screen → Screen address**에서 바꿀 수 있습니다(예: `/mosaic`). START 때 자동으로 띄우지 않으려면 *Show the screen on START*를 끕니다.
4. **누군가 화면을 쓰는 동안은 로봇이 움직이지 않습니다.** 화면이 터치될 때마다 앱에 알려 주고, 터치가 오면 즉시 멈춥니다.
   그림을 그리거나 메모를 쓰는 중이면 마지막 터치 후 20초, 그 밖의 화면(첫 화면, 그림 보기, 제출 완료)에서는 8초 동안
   터치가 없을 때 다시 움직입니다. 끄려면 **Camera & screen → Stop while someone is using the screen**.
   관람객 화면은 60초 동안 조작이 없으면 스스로 첫 화면으로 돌아갑니다.
5. 화면이 꺼지면 멈추므로 iPhone **설정 → 디스플레이 및 밝기 → 자동 잠금 → 안 함**으로 두세요.

### Manual: 직접 조종
**Manual drive** 탭에서 원형 조이스틱을 드래그하거나 노트북에서 **W A S D / 방향키**를 누릅니다. 손을 떼면 멈춥니다.
수동 조종에는 카메라가 필요 없습니다. 노트북 Chrome에서 바로 로봇에 연결해 조종할 수 있습니다.
BLE는 한 번에 한 기기만 연결되므로, 휴대폰이 연결되어 있으면 노트북에서는 연결되지 않습니다.

## 4. 잘 안 될 때 (Settings에서 조정, 값은 브라우저에 저장됨)

| 증상 | 조정 |
|---|---|
| 모형이 파랗게 칠해지지 않음 | 다시 **Calibrate**. 그래도 부족하면 *Brightness tolerance* / *Tint tolerance* 올리기 |
| 바닥·벽·그림자까지 파랗게 칠해짐 | *Tint tolerance*를 낮추고 다시 Calibrate. 회색 바닥 위라면 밝은/색 있는 바닥에서 시험 |
| 모형이 칠해지는데 노란 상자가 안 생김 | 모형이 화면에서 납작하게 보이는 경우: *Figure shape*를 실제 비율(세로÷가로)에 맞추기. 작으면 *Smallest figure* 낮추기 |
| 너무 멀리서/가까이서 멈춤 | *Stop when the person fills* 조정 |
| 서 있는 모형인데 다가가지 않고 "Walking person"으로 나옴 | 검출 상자가 흔들리는 것: 다시 Calibrate 하거나 *Counts as walking: sideways movement*를 올리기 |
| 걷는 사람을 따라감 | *Counts as walking: sideways movement*를 낮추기 |
| 인사 후 너무 빨리/늦게 떠남 | *Wait for a touch after greeting* 조정 |
| 지나갈 때 덜/더 돌거나 너무 멀리 감 | *No response: turn away for* / *then drive on for* 조정 (전진을 0으로 두면 돌기만 함) |
| 말소리가 안 남 | 무음 스위치·볼륨 확인, START를 다시 누르기, **Test voice**. 그래도 안 되면 그 브라우저가 음성 합성을 지원하지 않는 것(말풍선은 뜸) |
| 화면이 안 움직임 / 반대로 움직임 / 끝까지 안 감 | 서보 전원 확인, 스케치의 `HEIGHT_LOW_ANGLE` / `HEIGHT_HIGH_ANGLE` 조정 |
| 좌우로 흔들리며 감 | *Steering strength* 낮추기 |
| 바퀴가 웅- 소리만 나고 안 돎 | 스케치의 `MIN_DUTY`(기본 90)를 올리기 |
| 전진했는데 반대로 감 / 좌우가 바뀜 | **Wheels & log**에서 Reverse / Swap. *Test left/right ▲*를 누르고 있으면 해당 바퀴가 앞으로 돌아야 정상 |

검출은 "회색이면서 세로로 긴 덩어리"를 찾는 단순한 방식이라, 회색 바닥·콘크리트·그림자가 많은 곳에서는 헷갈릴 수 있습니다.
시연 장소의 바닥과 배경 색이 회색과 다르면 가장 안정적입니다.

## 개발

```bash
npm test                 # 단위 테스트 (Node 20+)
python -m http.server 8000   # http://localhost:8000/web/ (localhost는 HTTPS 없이도 카메라·BLE 허용)
```

BLE 프로토콜: 서비스 `c5831c08-81a7-4b41-bc27-ce21e6c8a9d0`, 이름 `MockingbirdBot`.
명령 특성 `ae8acab1-…` (write without response, 약 20 Hz) 4바이트 `[seq lo, seq hi, left, right]`,
left/right는 -100..100 (%) int8, + = 전진. ACK 특성 `d55045a0-…` (notify)는 seq를 그대로 돌려줍니다.
보드는 0이 아닌 속도를 `MIN_DUTY..255`로 바꾸고, 가속은 약 0.16초에 걸쳐 부드럽게 올립니다. 정지는 즉시 합니다.
높이 특성 `535aa1fd-…` (write / write without response) 1바이트: 0..100 = 화면 높이(%). 보드는 첫 값을 받을 때 서보를 켜고
(전원을 켤 때 갑자기 움직이지 않도록), 그 뒤로는 연결이 끊겨도 자리를 유지합니다. 이 특성이 없는 예전 스케치에서도 주행은 됩니다.
