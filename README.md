# MCU Playground

A simulated STM32F072RB (ARM Cortex-M0) with a board full of sensors and actuators,
for practising embedded C. You write real register-level code, it is compiled with
the real `arm-none-eabi-gcc`, and the resulting firmware runs instruction by
instruction on an emulated chip in the browser.

## Run it

```bash
npm install
```

```bash
npm run toolchain
```

```bash
npm run dev
```

`npm run toolchain` downloads the ARM compiler once (about 1 GB, stored in a
per-user xPack folder and linked into `xpacks/`). Then open the address `npm run dev`
prints. Your code is saved automatically to `workspace/<project>/`.

## What you get

- **Sandbox**: the full board and an empty-ish `main.c`.
- **16 exercises** with a task, the background an interviewer expects you to
  know, starter code, automatic checks and a reference solution: GPIO, bit masks,
  SysTick, debouncing, EXTI, timer interrupts, PWM, ADC, hysteresis, input capture,
  ISR data sharing, state machines, watchdog, UART ring buffer, low power, C drills.
- **Three views of the same board**: friendly devices, a live schematic (wires
  coloured by net state, click a wire to trace it) and a 3D board.
- **Pin trace** (logic-analyser style), **serial console**, and **hints** that
  explain mistakes which fail silently on real hardware (peripheral clock off,
  floating input, interrupt flag never cleared, UART overrun, ...).
- **HardFault explanations** with the source line.
- **Built-in reference**: how to find a register in the documentation, the source
  documents (RM0091, datasheet, PM0215, UM1724, device datasheets), and every simulated
  register bit by bit with what it does and why. Hover a register or bit macro in the
  editor, press F1 on it, or type `RCC->` for a list. Bit positions, macro names and
  offsets are checked against ST's header by `tests/reference.test.ts`.

## Board pin map

| Pin | Device | Pin | Device |
|---|---|---|---|
| PA5 | on-board LED | PC13 | on-board button (0 = pressed, pull-up fitted) |
| PC8 / PC9 / PC10 / PC11 | red / yellow / green / blue LED | PB4 / PB5 / PB0 | RGB LED (R / G / B) |
| PB8 / PB9 | button A / B (to GND, no pull-up fitted) | PA0 | potentiometer |
| PA1 | temperature sensor (500 mV + 10 mV/°C) | PA6 | light sensor |
| PA4 | buzzer | PB10 | servo |
| PA7, PA9, PA10 | motor PWM, direction 1, direction 2 | PA8 / PB3 | ultrasonic trigger / echo |
| PC0..PC7 | 7-segment a b c d e f g dp | PA2 / PA3 | serial console TX / RX (115200) |
| PB6 / PB7 | I2C1 SCL / SDA: temperature sensor (0x48), EEPROM (0x50) | PB13 / PB14 / PB15 | SPI2 SCK / MISO / MOSI |
| PB12 | LED bar latch (74HC595) | PB11 | accelerometer chip select |

## What is simulated

CPU: the complete ARMv6-M instruction set with Cortex-M0 cycle counts, exceptions,
NVIC priorities, PendSV/SVC, SysTick, `WFI` sleep, HardFault (including unaligned
access).

Peripherals (register level): RCC (clock gating, HSI / HSI48 / PLL), GPIO A-D and F,
SYSCFG + EXTI, TIM2 / TIM3 / TIM14 / TIM6 / TIM7 (up-counting, PWM, output compare,
input capture, one-pulse), ADC, USART2, IWDG, I2C1 (master) and SPI2 (master),
with bit-accurate waveforms on the bus pins.

Not simulated: SPI1, I2C2, I2C/SPI slave mode, DMA, USB, CAN, RTC, TIM1 and TIM15-17, down-counting and
encoder timer modes, low-power Stop/Standby. Touching one of these gives a hint
instead of a crash.

## Tests

```bash
npm test
```

- `cpu-diff`: the same C program (CRC, 64-bit math, soft-float, sorting, setjmp,
  malloc, ...) is compiled for the PC and for the emulated chip at four optimisation
  levels; the outputs must be identical.
- `cpu-flags`: 64,000 single-instruction cases checked against an independent model
  of the ARM pseudo-code.
- `peripherals`: timing and behaviour of each peripheral, measured on the pins.
- `exercises`: every reference solution passes its checks, every starter fails.
- `api`: the local compile / save API.

## Layout

```
firmware/        startup code, linker script, syscalls, CMSIS headers (ST and ARM, Apache-2.0)
server/          arm-none-eabi-gcc wrapper used by the dev-server API and the tests
src/emu/         CPU core, bus, clock, ELF loader, peripherals
src/board/       nets, devices, board definition
src/exercises/   exercises and the headless check runner
src/worker/      simulation worker
src/ui/          React UI
tests/           test suite
```
