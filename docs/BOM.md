# Bill of materials

Where to buy each item, with a store route from Burlingame: [SHOPPING_LIST.md](SHOPPING_LIST.md).

**Mode column:**
- **Core:** needed for everything.
- **Eyes / Jaw / Relay:** body modes.
- **Pi:** Raspberry Pi mode.
- **Prop:** the pumpkin itself.

| # | Item | Qty | Mode | Est. cost | Where | Notes |
|---|---|---|---|---|---|---|
| 1 | Logitech C920s Pro HD webcam | 1 | Core | $60–70 | Best Buy, Micro Center, Central Computers | 78° field of view, plug-and-play on Mac and Pi |
| 2 | Anker PowerConf USB speakerphone | 1 | Core | $110–140 | Best Buy ([link](https://www.bestbuy.com/site/anker-powerconf-bluetooth-speakerphone-conference-speaker-black/6421726.p?skuId=6421726)) | 6 mics with echo cancellation. Use USB, not Bluetooth. Upgrade: Jabra Speak2 55. |
| 3 | Powered USB 3 hub, 4+ ports, with its own power supply | 1 | Core | $25–35 | Best Buy, Central Computers | Sits at the prop; camera, speakerphone and Arduino plug into it |
| 4 | Active (repeater) USB 3 extension, 16 ft | 1 | Core | $20 | Central Computers, Micro Center, [Amazon](https://www.amazon.com/s?k=active+usb+3.0+extension+cable+16ft) | Keeps the Mac indoors. Passive cables over 15 ft are unreliable. |
| 5 | USB-C to USB-A adapter | 1 | Core | $10 | Best Buy | Only if your Mac is USB-C only |
| 6 | Warm LED clamp light or small flood light | 1 | Core | $15–25 | Home Depot | **Light the visitors**, or the camera can't see costumes |
| 7 | Outdoor extension cord (25 ft) and power strip | 1 | Core | $20–30 | Home Depot | Powers the hub and light |
| 8 | Hollow foam craft pumpkin, 12–18" | 1 | Prop | $15–30 | Michaels, Target | Must fit the speakerphone inside |
| 9 | Black tulle or speaker-grille fabric | 1 | Prop | $5 | Michaels | Hides the camera and speaker behind the carved mouth |
| 10 | Critic costume: beret or toque, monocle, bow tie | 1 set | Prop | $10–20 | Michaels, Spirit Halloween | Jacques O'Lantern's look |
| 11 | Hot glue, zip ties, gaffer tape, Velcro | — | Prop | $15 | Michaels, Home Depot | |
| 12 | Arduino Uno starter kit (Elegoo "Most Complete" or similar) | 1 | Eyes/Jaw/Relay | $35–60 | Central Computers (call ahead), [Micro Center](https://www.microcenter.com/product/704602/elegoo-uno-r3-project-most-complete-starter-kit-with-tutorial-compatible-with-arduino-ide-(200-components)) | Includes the Uno, USB cable, breadboard, jumpers, **SG90 servo** and **5V relay** |
| 13 | NeoPixel Jewel 7 RGB (Adafruit #2226) | 3 | Eyes | $6 each | Central Computers (call), [Micro Center](https://www.microcenter.com/product/456218/adafruit-industries-neopixel-jewel-7-x-ws2812-5050-rgb-led-with-integrated-drivers), [Adafruit](https://www.adafruit.com/product/2226) | Two are eyes, one is a spare. Needs 3 short wires soldered on. |
| 14 | 330 Ω resistor | 1 | Eyes | in kit | Starter kit | In series with the NeoPixel data line |
| 15 | Soldering iron kit and solder | 1 | Eyes | $20 | Central Computers, Micro Center | Skip if you have one |
| 16 | 22 AWG stranded hookup wire, about 10 ft | 1 | Eyes | $5 | Central Computers, Micro Center | Runs the eye wires inside the pumpkin |
| 17 | SG90 micro servo | 1 | Jaw | in kit | Starter kit | Optional, last phase |
| 18 | 5V relay module | 1 | Relay | in kit | Starter kit | Parked until a suitable animatronic is found |
| 19 | CanaKit Raspberry Pi 5 8GB Starter MAX kit | 1 | Pi | ~$180 | [Best Buy](https://www.bestbuy.com/product/canakit-raspberry-pi-5-starter-max-kit-8gb-turbine-white/JXS4YQC29W/sku/6580288), Central Computers | Includes the power supply, case with cooler and preloaded SD card. Optional; Mac mode doesn't need it. |

## Totals (approximate)
| Group | Cost |
|---|---|
| Core (items 1–7) | $260–330 |
| Prop (items 8–11) | $45–90 |
| Body: eyes (items 12–16) | $80–110 |
| Pi kit (item 19) | ~$180 |
| **Everything** | **~$565–710** |
| **Minimum to get talking** (webcam, speakerphone, light, pumpkin; the Mac's built-in camera and mic also work for bench testing) | **~$200** |

## Software and services
- An OpenAI API key with access to GPT-Live (`gpt-live-1`) and a vision-capable Responses model. Set a monthly spend limit.
- Node.js 22.6+, Chrome, and the Arduino IDE (with the Adafruit NeoPixel library).
