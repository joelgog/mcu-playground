/** Exercises 1-4: GPIO, bit manipulation, SysTick time base, debouncing. */
import { Led } from '../board/devices';
import { fmt, near, toggles, wave } from './runner';
import { Exercise } from './types';

const c = String.raw;

const DELAY_MS = c`/* Provided: blocks for the given number of milliseconds using the SysTick counter. */
static void delay_ms(uint32_t ms)
{
    SysTick->LOAD = SystemCoreClock / 1000u - 1u;
    SysTick->VAL = 0;
    SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_ENABLE_Msk;
    while (ms--) {
        while (!(SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk)) {
        }
    }
    SysTick->CTRL = 0;
}
`;

export const helloGpio: Exercise = {
  id: 'hello-gpio',
  title: 'Hello GPIO',
  summary: 'Blink the on-board LED at 1 Hz',
  brief:
    'Make the on-board LED (pin `PA5`) blink: 500 ms on, 500 ms off.\n\n' +
    'Three things are needed: switch on the clock of GPIO port A, make PA5 an output, then toggle it in a loop.',
  background:
    'Every STM32 peripheral is clock-gated to save power. Until you set the enable bit in `RCC->AHBENR`, writes to `GPIOA` are silently ignored. ' +
    'This is the classic "my LED does nothing" bug.\n\n' +
    '`MODER` has two bits per pin: `00` input, `01` output, `10` alternate function, `11` analog. Use `|=` and `&= ~` so you only change the bits of your pin. ' +
    'Overwriting the whole register with `=` would also reconfigure PA13/PA14, the debug pins, and you would lock yourself out of the debugger on real hardware.\n\n' +
    'To toggle, either XOR the output register (`GPIOA->ODR ^= 1u << 5`) or write to `BSRR`, which sets or clears pins atomically without a read-modify-write.',
  devices: ['ld2'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

${DELAY_MS}
int main(void)
{
    /* TODO 1: switch on the clock of GPIO port A (RCC->AHBENR). */

    /* TODO 2: make PA5 a push-pull output (GPIOA->MODER, two bits per pin). */

    for (;;) {
        /* TODO 3: toggle PA5. */

        delay_ms(500);
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

${DELAY_MS}
int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN;

    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;

    for (;;) {
        GPIOA->ODR ^= 1u << 5;
        delay_ms(500);
    }
}
`,
  },
  check(ctx) {
    const led = ctx.trace('PA5');
    ctx.run(3.7);
    const port = ctx.mcu.ports.get('A')!;
    ctx.expect('PA5 is configured as an output', port.mode(5) === 1, `PA5 is: ${port.describe(5)}`);
    const w = wave(led);
    ctx.expect('LED blinks at 1 Hz', near(w.freq, 1, 0.03), w.periods ? `measured ${fmt(w.freq)} Hz` : 'the pin never toggled');
    ctx.expect('On and off times are equal', w.periods > 0 && near(w.duty, 0.5, 0.05), `high ${fmt(w.duty * 100)} % of the time`);
    ctx.expect(
      'Debug pins PA13/PA14 left untouched',
      (port.moder & 0x3c000000) >>> 0 === 0x28000000,
      (port.moder & 0x3c000000) >>> 0 === 0x28000000 ? 'MODER bits 27:26 still select the debug function' : 'MODER was overwritten: PA13/PA14 are no longer debug pins',
    );
  },
};

export const bitMasks: Exercise = {
  id: 'bit-masks',
  title: 'Bit masks and BSRR',
  summary: 'Drive an LED pattern from a button',
  brief:
    'While the on-board button (`PC13`, reads 0 when pressed) is held: light the on-board LED (`PA5`), the red LED (`PC8`) and the green LED (`PC10`); yellow (`PC9`) and blue (`PC11`) must be off.\n\n' +
    'While it is released: the opposite. Yellow and blue on, the other three off.',
  background:
    'Interviewers use this kind of task to see whether you can set, clear and test bits without disturbing their neighbours.\n\n' +
    'Set bits with `reg |= mask`, clear with `reg &= ~mask`, test with `reg & mask`. For a multi-bit field: `reg = (reg & ~(mask << shift)) | (value << shift)`.\n\n' +
    '`BSRR` is worth knowing: the low 16 bits set pins, the high 16 bits reset pins, in a single write. Because there is no read-modify-write, an interrupt cannot sneak in between and corrupt the port. ' +
    'The button is "active low": it connects the pin to ground when pressed, and a pull-up resistor holds it high otherwise.',
  devices: ['b1', 'ld2', 'led_red', 'led_yellow', 'led_green', 'led_blue'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/*
 * PC13  on-board button, 0 = pressed (external pull-up fitted)
 * PA5   on-board LED
 * PC8   red LED      PC9   yellow LED
 * PC10  green LED    PC11  blue LED
 */

int main(void)
{
    /* TODO: enable the clocks of port A and port C. */

    /* TODO: PA5 and PC8..PC11 as outputs. PC13 is an input after reset. */

    for (;;) {
        /* TODO: read PC13 and write the LED pattern.
         * Tip: one write to GPIOC->BSRR can set some pins and reset others. */
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

#define LED_BOARD  (1u << 5)    /* PA5  */
#define LED_RED    (1u << 8)    /* PC8  */
#define LED_YELLOW (1u << 9)    /* PC9  */
#define LED_GREEN  (1u << 10)   /* PC10 */
#define LED_BLUE   (1u << 11)   /* PC11 */
#define BUTTON     (1u << 13)   /* PC13 */

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOCEN;

    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
    /* PC8..PC11: four 2-bit fields starting at bit 16, each set to 01 */
    GPIOC->MODER = (GPIOC->MODER & ~(0xFFu << 16)) | (0x55u << 16);

    for (;;) {
        if ((GPIOC->IDR & BUTTON) == 0u) {
            GPIOA->BSRR = LED_BOARD;
            GPIOC->BSRR = LED_RED | LED_GREEN | ((LED_YELLOW | LED_BLUE) << 16);
        } else {
            GPIOA->BSRR = LED_BOARD << 16;
            GPIOC->BSRR = LED_YELLOW | LED_BLUE | ((LED_RED | LED_GREEN) << 16);
        }
    }
}
`,
  },
  check(ctx) {
    const lit = (id: string) => ctx.board.device<Led>(id).lit();
    const pattern = () => ['ld2', 'led_red', 'led_yellow', 'led_green', 'led_blue'].map((id) => (lit(id) ? '1' : '0')).join('');
    const show = (p: string) => `board=${p[0]} red=${p[1]} yellow=${p[2]} green=${p[3]} blue=${p[4]}`;
    ctx.run(0.05);
    let p = pattern();
    ctx.expect('Released: yellow and blue on, others off', p === '00101', show(p));
    ctx.board.button('b1').set(true);
    ctx.run(0.05);
    p = pattern();
    ctx.expect('Pressed: board LED, red and green on, others off', p === '11010', show(p));
    ctx.board.button('b1').set(false);
    ctx.run(0.05);
    p = pattern();
    ctx.expect('Released again: back to yellow and blue', p === '00101', show(p));
    const a = ctx.mcu.ports.get('A')!;
    const cPort = ctx.mcu.ports.get('C')!;
    ctx.expect(
      'Only the needed MODER bits were changed',
      (a.moder & 0x3c000000) >>> 0 === 0x28000000 && cPort.mode(13) === 0 && cPort.mode(0) === 0,
      (a.moder & 0x3c000000) >>> 0 !== 0x28000000
        ? 'GPIOA->MODER was overwritten: the debug pins PA13/PA14 were reconfigured'
        : cPort.mode(13) !== 0 || cPort.mode(0) !== 0
          ? 'GPIOC->MODER changed pins other than PC8..PC11'
          : 'other pins keep their reset configuration',
    );
  },
};

export const systickTimebase: Exercise = {
  id: 'systick',
  title: 'SysTick time base',
  summary: 'Two LEDs at different rates without blocking',
  brief:
    'Set up the SysTick timer to interrupt every millisecond and count the interrupts in `ms_ticks`.\n\n' +
    'Using that time base, toggle the on-board LED (`PA5`) every 250 ms and the red LED (`PC8`) every 400 ms. Both must run at the same time, so `delay_ms()`-style blocking will not work.',
  background:
    'SysTick is a 24-bit down-counter built into every Cortex-M core. `SysTick_Config(ticks)` loads the reload value, enables the counter and its interrupt. With `SystemCoreClock / 1000` it fires at 1 kHz. This is how almost every firmware (and every RTOS) gets its heartbeat.\n\n' +
    'The non-blocking pattern is: remember when you last did something, and compare against the current time on every pass through the main loop. ' +
    'Written as `now - last >= interval` with unsigned arithmetic it keeps working when the counter wraps around after 49 days.\n\n' +
    'A variable shared between an interrupt handler and main must be `volatile`, otherwise the compiler may read it once and cache the value in a register.',
  devices: ['ld2', 'led_red'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/* Milliseconds since start-up. Keep this name: the checker reads it. */
static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    /* TODO: count one millisecond. */
}

int main(void)
{
    /* TODO: clocks for GPIOA and GPIOC; PA5 and PC8 as outputs. */

    /* TODO: start SysTick at 1 kHz (hint: SysTick_Config). */

    for (;;) {
        /* TODO: toggle PA5 every 250 ms and PC8 every 400 ms, without blocking. */
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOCEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
    GPIOC->MODER = (GPIOC->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;

    SysTick_Config(SystemCoreClock / 1000u);

    uint32_t last_board = 0;
    uint32_t last_red = 0;

    for (;;) {
        uint32_t now = ms_ticks;

        if (now - last_board >= 250u) {
            last_board += 250u;
            GPIOA->ODR ^= 1u << 5;
        }
        if (now - last_red >= 400u) {
            last_red += 400u;
            GPIOC->ODR ^= 1u << 8;
        }
    }
}
`,
  },
  check(ctx) {
    const a = ctx.trace('PA5');
    const r = ctx.trace('PC8');
    ctx.run(4.3);
    const ticks = ctx.global('ms_ticks');
    ctx.expect(
      'ms_ticks counts milliseconds',
      ticks !== null && near(ticks, 4300, 15),
      ticks === null ? 'variable ms_ticks not found' : `${ticks} after 4300 ms`,
    );
    const wa = wave(a);
    const wr = wave(r);
    ctx.expect('On-board LED toggles every 250 ms (2 Hz)', near(wa.freq, 2, 0.02), wa.periods ? `measured ${fmt(wa.freq, 4)} Hz` : 'PA5 never toggled');
    ctx.expect('Red LED toggles every 400 ms (1.25 Hz)', near(wr.freq, 1.25, 0.0125), wr.periods ? `measured ${fmt(wr.freq, 4)} Hz` : 'PC8 never toggled');
  },
};

export const debounce: Exercise = {
  id: 'debounce',
  title: 'Debounce a button',
  summary: 'Count presses of a bouncy switch exactly once each',
  brief:
    'Count how often Button A (`PB8`) is pressed in `press_count`, and toggle the on-board LED on every press.\n\n' +
    'The button connects the pin to ground and has no external resistor. Its contacts bounce for up to 5 ms on every press and release. Each physical press must count exactly once.',
  background:
    'Mechanical contacts chatter for a few milliseconds when they close or open, so a microcontroller sees a burst of edges instead of one. Counting edges directly gives you 3-10 counts per press.\n\n' +
    'The standard fix is to sample the pin at a fixed rate (for example every millisecond from SysTick) and only accept a new state after it has been stable for N consecutive samples (10 ms is typical). ' +
    'Count a press on the transition of the debounced state, not while the level is low, otherwise a long hold counts many times.\n\n' +
    'Also note the missing pull-up: with the button open nothing drives the pin, so it floats and reads garbage. Enable the internal pull-up in `PUPDR`.',
  devices: ['sw1', 'ld2'],
  deviceOptions: { sw1: { bounceMs: 5 } },
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/* Number of presses so far. Keep this name: the checker reads it. */
volatile uint32_t press_count;

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;

    /* TODO: PB8 needs a defined level while the button is open. */

    uint32_t previous = 1;

    for (;;) {
        /* Naive version: counts every falling edge, including the bounces. Replace it. */
        uint32_t level = (GPIOB->IDR >> 8) & 1u;
        if (previous == 1u && level == 0u) {
            press_count++;
            GPIOA->ODR ^= 1u << 5;
        }
        previous = level;
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

#define DEBOUNCE_MS 10u

volatile uint32_t press_count;

static volatile uint8_t stable_level = 1;   /* debounced state, 1 = released */
static volatile uint8_t change_count;       /* consecutive samples that differ from it */

/* Runs every millisecond: accept a new level only after it held for DEBOUNCE_MS. */
void SysTick_Handler(void)
{
    uint8_t raw = (uint8_t)((GPIOB->IDR >> 8) & 1u);

    if (raw == stable_level) {
        change_count = 0;
    } else if (++change_count >= DEBOUNCE_MS) {
        stable_level = raw;
        change_count = 0;
        if (raw == 0u) {                    /* debounced falling edge = one press */
            press_count++;
            GPIOA->ODR ^= 1u << 5;
        }
    }
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
    GPIOB->PUPDR = (GPIOB->PUPDR & ~GPIO_PUPDR_PUPDR8) | GPIO_PUPDR_PUPDR8_0;   /* pull-up */

    SysTick_Config(SystemCoreClock / 1000u);

    for (;;) {
        __WFI();
    }
}
`,
  },
  check(ctx) {
    const led = ctx.trace('PA5');
    ctx.run(0.1);
    const start = ctx.global('press_count');
    ctx.expect('No presses counted before the button is touched', start === 0, start === null ? 'variable press_count not found' : `press_count = ${start}`);
    for (let i = 0; i < 10; i++) {
      ctx.press('sw1', 40 + 13 * i);
      ctx.run(0.06);
    }
    const afterTen = ctx.global('press_count') ?? -1;
    ctx.expect('10 presses are counted as 10', afterTen - (start ?? 0) === 10, `10 presses -> counted ${afterTen - (start ?? 0)}`);
    ctx.expect('LED toggles once per press', toggles(led) === 10, `LED toggled ${toggles(led)} times`);
    ctx.press('sw1', 1000);
    ctx.run(0.06);
    const afterHold = ctx.global('press_count') ?? -1;
    ctx.expect('Holding for 1 s counts once', afterHold - afterTen === 1, `counted ${afterHold - afterTen}`);
    ctx.expect(
      'Pin has a defined level when the button is open',
      !ctx.hinted('float:PB8'),
      ctx.hinted('float:PB8') ? 'PB8 floats: no pull-up enabled' : 'pull-up enabled',
    );
  },
};
