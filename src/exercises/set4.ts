/** Exercises 13-16: watchdog, UART ring buffer, low power, C drills. */
import { Led } from '../board/devices';
import { fmt, near, toggles, wave } from './runner';
import { Exercise } from './types';

const c = String.raw;

export const watchdog: Exercise = {
  id: 'watchdog',
  title: 'Watchdog',
  summary: 'Recover automatically from a hung main loop',
  brief:
    'The provided `process_sensors()` contains a bug you cannot fix: while Button A (`PB8`) is held it never returns, and the firmware hangs.\n\n' +
    'Start the independent watchdog with a timeout of about 200 ms and kick it from the main loop, so that a hang resets the chip. After a reset caused by the watchdog, switch the red LED (`PC8`) on.',
  background:
    'A watchdog is a hardware down-counter with its own clock. If the firmware does not reload ("kick") it in time, it resets the microcontroller. It is the last line of defence against a hang in the field.\n\n' +
    'The IWDG is controlled through key values written to `IWDG->KR`: `0xCCCC` starts it (it cannot be stopped again), `0x5555` unlocks `PR` and `RLR`, `0xAAAA` reloads the counter. ' +
    'Timeout = (4 x 2^PR) x (RLR + 1) / 40 kHz. The new reload value only takes effect at the next `0xAAAA`, so reload once right after configuring.\n\n' +
    'Where you kick matters: do it in one place in the main loop, never from a timer interrupt, otherwise the interrupt happily keeps kicking while main is dead.\n\n' +
    'After any reset, `RCC->CSR` tells you why: `IWDGRSTF` means the watchdog bit. The flags stay set until you clear them with `RMVF`, so read first, then clear. Logging the reset cause is standard practice in real products.',
  devices: ['ld2', 'led_red', 'sw1'],
  deviceOptions: { sw1: { bounceMs: 0 } },
  starter: {
    'main.c': c`#include "stm32f0xx.h"

static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}

/* Provided, do not change: hangs for as long as Button A is held. */
static void process_sensors(void)
{
    while ((GPIOB->IDR & (1u << 8)) == 0u) {
    }
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN | RCC_AHBENR_GPIOCEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
    GPIOC->MODER = (GPIOC->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;
    GPIOB->PUPDR = (GPIOB->PUPDR & ~GPIO_PUPDR_PUPDR8) | GPIO_PUPDR_PUPDR8_0;
    SysTick_Config(SystemCoreClock / 1000u);

    /* TODO 1: if this start-up was caused by the watchdog (RCC->CSR), switch the red LED on.
     *         Then clear the reset flags. */

    /* TODO 2: start the watchdog with a timeout of about 200 ms. */

    uint32_t last_blink = 0;

    for (;;) {
        /* TODO 3: kick the watchdog. */

        process_sensors();

        if (ms_ticks - last_blink >= 100u) {
            last_blink += 100u;
            GPIOA->ODR ^= 1u << 5;
        }
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

static void process_sensors(void)
{
    while ((GPIOB->IDR & (1u << 8)) == 0u) {
    }
}

static void watchdog_start(void)
{
    IWDG->KR = 0xCCCC;                      /* start (also starts the 40 kHz LSI oscillator) */
    IWDG->KR = 0x5555;                      /* unlock PR and RLR */
    IWDG->PR = 1;                           /* divide by 8: 5 kHz */
    IWDG->RLR = 1000u - 1u;                 /* 1000 ticks = 200 ms */
    while (IWDG->SR != 0u) {                /* wait until the new values are taken over */
    }
    IWDG->KR = 0xAAAA;                      /* reload with the new value */
}

static void watchdog_kick(void)
{
    IWDG->KR = 0xAAAA;
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN | RCC_AHBENR_GPIOCEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
    GPIOC->MODER = (GPIOC->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;
    GPIOB->PUPDR = (GPIOB->PUPDR & ~GPIO_PUPDR_PUPDR8) | GPIO_PUPDR_PUPDR8_0;
    SysTick_Config(SystemCoreClock / 1000u);

    if (RCC->CSR & RCC_CSR_IWDGRSTF) {
        GPIOC->BSRR = 1u << 8;              /* we are here because the watchdog bit */
    }
    RCC->CSR |= RCC_CSR_RMVF;               /* clear the reset flags for next time */

    watchdog_start();

    uint32_t last_blink = 0;

    for (;;) {
        watchdog_kick();

        process_sensors();

        if (ms_ticks - last_blink >= 100u) {
            last_blink += 100u;
            GPIOA->ODR ^= 1u << 5;
        }
    }
}
`,
  },
  check(ctx) {
    const beat = ctx.trace('PA5');
    const red = ctx.board.device<Led>('led_red');
    ctx.run(1.0);
    const wd = ctx.mcu.iwdg;
    ctx.expect(
      'Watchdog is running with a 100-400 ms timeout',
      wd.running && wd.timeoutSec() >= 0.1 && wd.timeoutSec() <= 0.4,
      wd.running ? `timeout is ${fmt(wd.timeoutSec() * 1000, 4)} ms` : 'IWDG was never started',
    );
    ctx.expect(
      'Normal operation: kicked in time, no reset',
      ctx.mcu.resetCount === 1 && toggles(beat) >= 8 && !red.lit(),
      ctx.mcu.resetCount > 1 ? `the chip reset ${ctx.mcu.resetCount - 1} time(s) without a hang` : red.lit() ? 'red LED is on after a normal power-up' : 'LED blinking, no resets',
    );
    const resetsBefore = ctx.mcu.resetCount;
    ctx.board.button('sw1').set(true);
    ctx.run(0.6);
    ctx.expect(
      'A hang triggers a watchdog reset',
      ctx.mcu.resetCount > resetsBefore && ctx.mcu.lastResetCause === 'iwdg',
      ctx.mcu.resetCount > resetsBefore ? `reset by the watchdog (${ctx.mcu.resetCount - resetsBefore}x while the button was held)` : 'firmware hung for 600 ms and nothing reset it',
    );
    ctx.board.button('sw1').set(false);
    ctx.run(0.3);
    const settled = ctx.mcu.resetCount;
    const tMark = ctx.mcu.clock.seconds();
    ctx.run(0.6);
    ctx.expect(
      'Firmware runs normally again after the reset',
      ctx.mcu.resetCount === settled && toggles(beat, tMark) >= 4,
      ctx.mcu.resetCount !== settled ? 'still resetting after the button was released' : `LED toggled ${toggles(beat, tMark)} times in 600 ms`,
    );
    ctx.expect('Red LED shows the watchdog reset', red.lit(), red.lit() ? 'red LED on' : 'red LED off');
  },
};

export const uartEcho: Exercise = {
  id: 'uart',
  title: 'UART ring buffer',
  summary: 'Receive bursts without losing bytes',
  brief:
    'Echo every character received on USART2 back in upper case. The main loop also has to call the provided `other_work()`, which takes about 3 ms, while a new byte can arrive every 87 us.\n\n' +
    'The starter polls the receiver and loses data. Receive in the interrupt handler and pass the bytes to the main loop through a ring buffer.',
  background:
    'The USART holds one received byte. If the next byte finishes before you have read `RDR`, the receiver sets the overrun flag (`ORE`) and the new byte is lost. At 115200 baud that window is 87 us, far shorter than a busy main loop.\n\n' +
    'The standard answer is an RX interrupt that moves each byte into a ring (circular) buffer: an array plus a head index (written only by the ISR) and a tail index (written only by main). ' +
    'With that single-producer, single-consumer split, no interrupt disabling is needed. Empty is `head == tail`; full is "advancing head would hit tail", which sacrifices one slot to tell the two apart.\n\n' +
    'Details interviewers probe: the indices must be `volatile`; a power-of-two size lets you wrap with `& (SIZE - 1)` instead of a division; decide what happens when the buffer is full (here: drop the byte); ' +
    'and if `ORE` does get set you must clear it via `ICR`, because it keeps the interrupt asserted.',
  devices: ['console'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/* Provided, do not change: the rest of the application, about 3 ms per call. */
static void other_work(void)
{
    for (volatile uint32_t i = 0; i < 1500u; i++) {
    }
}

static void uart_init(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
    RCC->APB1ENR |= RCC_APB1ENR_USART2EN;

    /* PA2 = TX, PA3 = RX: alternate function 1 */
    GPIOA->MODER = (GPIOA->MODER & ~(GPIO_MODER_MODER2 | GPIO_MODER_MODER3)) | GPIO_MODER_MODER2_1 | GPIO_MODER_MODER3_1;
    GPIOA->AFR[0] = (GPIOA->AFR[0] & ~0x0000FF00u) | 0x00001100u;

    USART2->BRR = SystemCoreClock / 115200u;
    USART2->CR1 = USART_CR1_TE | USART_CR1_RE | USART_CR1_UE;
}

static void uart_putc(char ch)
{
    while (!(USART2->ISR & USART_ISR_TXE)) {
    }
    USART2->TDR = (uint8_t)ch;
}

static char to_upper(char ch)
{
    return (ch >= 'a' && ch <= 'z') ? (char)(ch - 'a' + 'A') : ch;
}

int main(void)
{
    uart_init();

    for (;;) {
        other_work();

        /* Polling: by the time we get here, several bytes have come and gone. */
        if (USART2->ISR & USART_ISR_RXNE) {
            uart_putc(to_upper((char)USART2->RDR));
        }
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

#define RX_SIZE 128u                        /* power of two: wrap with a mask */
#define RX_MASK (RX_SIZE - 1u)

static volatile uint8_t rx_buffer[RX_SIZE];
static volatile uint32_t rx_head;           /* written by the interrupt only */
static volatile uint32_t rx_tail;           /* written by main only */

void USART2_IRQHandler(void)
{
    if (USART2->ISR & USART_ISR_RXNE) {
        uint8_t byte = (uint8_t)USART2->RDR;        /* reading RDR clears RXNE */
        uint32_t next = (rx_head + 1u) & RX_MASK;
        if (next != rx_tail) {                      /* drop the byte if the buffer is full */
            rx_buffer[rx_head] = byte;
            rx_head = next;
        }
    }
    if (USART2->ISR & USART_ISR_ORE) {
        USART2->ICR = USART_ICR_ORECF;              /* otherwise the interrupt never goes away */
    }
}

/* Returns 1 and stores a byte if one is available. */
static int rx_get(uint8_t *byte)
{
    if (rx_tail == rx_head) {
        return 0;
    }
    *byte = rx_buffer[rx_tail];
    rx_tail = (rx_tail + 1u) & RX_MASK;
    return 1;
}

static void other_work(void)
{
    for (volatile uint32_t i = 0; i < 1500u; i++) {
    }
}

static void uart_init(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
    RCC->APB1ENR |= RCC_APB1ENR_USART2EN;

    GPIOA->MODER = (GPIOA->MODER & ~(GPIO_MODER_MODER2 | GPIO_MODER_MODER3)) | GPIO_MODER_MODER2_1 | GPIO_MODER_MODER3_1;
    GPIOA->AFR[0] = (GPIOA->AFR[0] & ~0x0000FF00u) | 0x00001100u;

    USART2->BRR = SystemCoreClock / 115200u;
    USART2->CR1 = USART_CR1_TE | USART_CR1_RE | USART_CR1_RXNEIE | USART_CR1_UE;
    NVIC_EnableIRQ(USART2_IRQn);
}

static void uart_putc(char ch)
{
    while (!(USART2->ISR & USART_ISR_TXE)) {
    }
    USART2->TDR = (uint8_t)ch;
}

static char to_upper(char ch)
{
    return (ch >= 'a' && ch <= 'z') ? (char)(ch - 'a' + 'A') : ch;
}

int main(void)
{
    uart_init();

    for (;;) {
        uint8_t byte;

        other_work();

        while (rx_get(&byte)) {
            uart_putc(to_upper((char)byte));
        }
    }
}
`,
  },
  check(ctx) {
    const con = ctx.board.console!;
    ctx.run(0.02);
    con.send('a');
    ctx.run(0.03);
    ctx.expect('A single character is echoed in upper case', ctx.serial() === 'A', `sent "a", received ${JSON.stringify(ctx.serial())}`);
    const mark1 = ctx.serial().length;
    con.send('hello, world\n');
    ctx.run(0.06);
    const got1 = ctx.serial().slice(mark1);
    ctx.expect('A 13-byte burst arrives complete', got1 === 'HELLO, WORLD\n', `received ${JSON.stringify(got1)}`);
    const mark2 = ctx.serial().length;
    const burst = 'the quick brown fox jumps over the lazy dog 0123456789 times\n';
    con.send(burst);
    ctx.run(0.12);
    const got2 = ctx.serial().slice(mark2);
    ctx.expect(
      `A ${burst.length}-byte burst arrives complete and in order`,
      got2 === burst.toUpperCase(),
      got2 === burst.toUpperCase() ? 'all bytes echoed' : `received ${got2.length} of ${burst.length} bytes: ${JSON.stringify(got2.slice(0, 40))}`,
    );
    ctx.expect(
      'No receiver overrun',
      !ctx.hinted('USART2:ore'),
      ctx.hinted('USART2:ore') ? 'ORE was set: bytes arrived faster than RDR was read' : 'RDR was always read in time',
    );
  },
};

export const lowPower: Exercise = {
  id: 'low-power',
  title: 'Sleep between events',
  summary: 'Blink at 1 Hz with the CPU asleep 95 % of the time',
  brief:
    'The starter blinks the on-board LED at 1 Hz with a busy-wait delay, which keeps the CPU running flat out.\n\n' +
    'Keep the same blink, but let the CPU sleep whenever there is nothing to do. It must be asleep for more than 95 % of the time.',
  background:
    'A busy-wait loop burns full run current (several milliamps) to do nothing. On a battery that is the difference between days and years.\n\n' +
    'The `WFI` instruction ("wait for interrupt", `__WFI()` in CMSIS) stops the CPU clock until any enabled interrupt arrives. Peripherals keep running. The pattern is: let a timer interrupt do the time keeping, and have the main loop do `__WFI()` whenever it has no work.\n\n' +
    'After waking, the handler runs, then execution continues right after the `WFI`, so the main loop re-checks whether there is work and goes back to sleep. ' +
    'A slower wake-up source means more time asleep: a 1 kHz SysTick wakes a thousand times a second, a 2 Hz timer interrupt only twice. ' +
    'Deeper modes (Stop, Standby) save much more but need more care with clocks and wake-up sources.',
  devices: ['ld2'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/* Busy-wait delay: correct timing, but the CPU never rests. */
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
  solution: {
    'main.c': c`#include "stm32f0xx.h"

/* TIM3 update interrupt, twice per second: the only time the CPU has to wake up. */
void TIM3_IRQHandler(void)
{
    if (TIM3->SR & TIM_SR_UIF) {
        TIM3->SR = ~TIM_SR_UIF;
        GPIOA->ODR ^= 1u << 5;
    }
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;

    RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
    TIM3->PSC = 8000u - 1u;                 /* 8 MHz / 8000 = 1 kHz tick */
    TIM3->ARR = 500u - 1u;                  /* update every 500 ms */
    TIM3->EGR = TIM_EGR_UG;
    TIM3->SR = 0;
    TIM3->DIER = TIM_DIER_UIE;
    NVIC_EnableIRQ(TIM3_IRQn);
    TIM3->CR1 = TIM_CR1_CEN;

    for (;;) {
        __WFI();                            /* sleep until the next interrupt */
    }
}
`,
  },
  check(ctx) {
    const led = ctx.trace('PA5');
    ctx.run(0.3);
    const sleep0 = ctx.mcu.cpu.sleepCycles;
    const cyc0 = ctx.mcu.clock.cycles;
    ctx.run(3.4);
    const asleep = (ctx.mcu.cpu.sleepCycles - sleep0) / (ctx.mcu.clock.cycles - cyc0);
    const w = wave(led);
    ctx.expect('LED still blinks at 1 Hz', near(w.freq, 1, 0.01), w.periods ? `measured ${fmt(w.freq, 4)} Hz` : 'PA5 never toggled');
    ctx.expect('CPU is asleep more than 95 % of the time', asleep > 0.95, `asleep ${fmt(asleep * 100, 4)} % of the time`);
  },
};

const DRILLS_H = c`/* Interface for the C drills. Read-only: the test harness is built against it. */
#ifndef DRILLS_H
#define DRILLS_H

#include <stdbool.h>
#include <stdint.h>

/* Number of 1 bits in x. */
uint32_t count_set_bits(uint32_t x);

/* Bit 0 becomes bit 31, bit 1 becomes bit 30, ... */
uint32_t reverse_bits(uint32_t x);

/* 0x11223344 becomes 0x44332211. */
uint32_t swap_endian32(uint32_t x);

/* True for 1, 2, 4, 8, ... (not for 0). */
bool is_power_of_two(uint32_t x);

/* Replace one field of a register value: the field is 'mask' wide (e.g. 0x3 for two bits),
 * starts at bit 'shift', and gets 'value'. All other bits of 'reg' are preserved. */
uint32_t set_field(uint32_t reg, uint32_t mask, uint32_t shift, uint32_t value);

/* Byte FIFO. */
#define RING_SIZE 8u

typedef struct {
    uint8_t data[RING_SIZE];
    uint32_t head;      /* next write position */
    uint32_t tail;      /* next read position  */
} ring_t;

void ring_init(ring_t *r);
bool ring_put(ring_t *r, uint8_t byte);     /* false if the buffer is full  */
bool ring_get(ring_t *r, uint8_t *byte);    /* false if the buffer is empty */
uint32_t ring_count(const ring_t *r);       /* bytes currently stored       */

#endif
`;

const DRILLS_HARNESS = c`/* Test harness for the C drills. Read-only. Results go to the serial console. */
#include <stdio.h>
#include "drills.h"

static int failures;

static void check_u32(const char *name, uint32_t got, uint32_t want)
{
    if (got != want) {
        printf("FAIL %s: got 0x%08lx, want 0x%08lx\n", name, (unsigned long)got, (unsigned long)want);
        failures++;
    }
}

static void finish(const char *group, int before)
{
    printf("%s %s\n", failures == before ? "PASS" : "DONE", group);
}

static void test_bits(void)
{
    int before = failures;
    check_u32("count_set_bits(0)", count_set_bits(0u), 0u);
    check_u32("count_set_bits(1)", count_set_bits(1u), 1u);
    check_u32("count_set_bits(0xFFFFFFFF)", count_set_bits(0xFFFFFFFFu), 32u);
    check_u32("count_set_bits(0x80000001)", count_set_bits(0x80000001u), 2u);
    check_u32("count_set_bits(0xA5A5F00F)", count_set_bits(0xA5A5F00Fu), 16u);
    finish("count_set_bits", before);

    before = failures;
    check_u32("reverse_bits(1)", reverse_bits(1u), 0x80000000u);
    check_u32("reverse_bits(0x80000000)", reverse_bits(0x80000000u), 1u);
    check_u32("reverse_bits(0x12345678)", reverse_bits(0x12345678u), 0x1E6A2C48u);
    check_u32("reverse_bits(0xF0000000)", reverse_bits(0xF0000000u), 0x0000000Fu);
    check_u32("reverse_bits(0)", reverse_bits(0u), 0u);
    finish("reverse_bits", before);

    before = failures;
    check_u32("swap_endian32(0x11223344)", swap_endian32(0x11223344u), 0x44332211u);
    check_u32("swap_endian32(0x000000FF)", swap_endian32(0x000000FFu), 0xFF000000u);
    check_u32("swap_endian32(0xFF000000)", swap_endian32(0xFF000000u), 0x000000FFu);
    check_u32("swap_endian32(0x80FF7F01)", swap_endian32(0x80FF7F01u), 0x017FFF80u);
    finish("swap_endian32", before);

    before = failures;
    check_u32("is_power_of_two(0)", is_power_of_two(0u), 0u);
    check_u32("is_power_of_two(1)", is_power_of_two(1u), 1u);
    check_u32("is_power_of_two(64)", is_power_of_two(64u), 1u);
    check_u32("is_power_of_two(0x80000000)", is_power_of_two(0x80000000u), 1u);
    check_u32("is_power_of_two(6)", is_power_of_two(6u), 0u);
    check_u32("is_power_of_two(0xFFFFFFFF)", is_power_of_two(0xFFFFFFFFu), 0u);
    finish("is_power_of_two", before);

    before = failures;
    check_u32("set_field(0, 0x3, 10, 1)", set_field(0u, 0x3u, 10u, 1u), 0x00000400u);
    check_u32("set_field(0xFFFFFFFF, 0x3, 10, 1)", set_field(0xFFFFFFFFu, 0x3u, 10u, 1u), 0xFFFFF7FFu);
    check_u32("set_field(0x28000000, 0x3, 10, 2)", set_field(0x28000000u, 0x3u, 10u, 2u), 0x28000800u);
    check_u32("set_field(0x12345678, 0xF, 28, 0xA)", set_field(0x12345678u, 0xFu, 28u, 0xAu), 0xA2345678u);
    check_u32("set_field(0, 0x3, 4, 0xFF)", set_field(0u, 0x3u, 4u, 0xFFu), 0x00000030u);
    finish("set_field", before);
}

static void test_ring(void)
{
    int before = failures;
    ring_t r;
    uint8_t b = 0;

    ring_init(&r);
    check_u32("new ring: count", ring_count(&r), 0u);
    check_u32("new ring: get returns false", ring_get(&r, &b), 0u);

    for (uint32_t i = 0; i < 5u; i++) {
        check_u32("put into a ring with space", ring_put(&r, (uint8_t)(10u + i)), 1u);
    }
    check_u32("count after 5 puts", ring_count(&r), 5u);
    for (uint32_t i = 0; i < 5u; i++) {
        check_u32("get returns true", ring_get(&r, &b), 1u);
        check_u32("bytes come out in FIFO order", b, 10u + i);
    }
    check_u32("empty again: count", ring_count(&r), 0u);

    /* fill completely: the ring must accept 7 or 8 bytes, then refuse */
    uint32_t accepted = 0;
    for (uint32_t i = 0; i < 12u; i++) {
        if (ring_put(&r, (uint8_t)(100u + i))) {
            accepted++;
        }
    }
    if (accepted != RING_SIZE && accepted != RING_SIZE - 1u) {
        printf("FAIL ring accepted %lu bytes, expected %lu or %lu\n", (unsigned long)accepted,
               (unsigned long)(RING_SIZE - 1u), (unsigned long)RING_SIZE);
        failures++;
    }
    check_u32("count when full", ring_count(&r), accepted);
    for (uint32_t i = 0; i < accepted; i++) {
        check_u32("get from a full ring", ring_get(&r, &b), 1u);
        check_u32("order preserved across wrap-around", b, 100u + i);
    }
    check_u32("drained: get returns false", ring_get(&r, &b), 0u);

    /* many laps around the buffer */
    for (uint32_t i = 0; i < 100u; i++) {
        check_u32("lap: put", ring_put(&r, (uint8_t)i), 1u);
        check_u32("lap: put", ring_put(&r, (uint8_t)(i + 1u)), 1u);
        check_u32("lap: get", ring_get(&r, &b), 1u);
        check_u32("lap: first byte", b, (uint8_t)i);
        check_u32("lap: get", ring_get(&r, &b), 1u);
        check_u32("lap: second byte", b, (uint8_t)(i + 1u));
    }
    check_u32("count after laps", ring_count(&r), 0u);
    finish("ring buffer", before);
}

int main(void)
{
    test_bits();
    test_ring();
    printf("END %d\n", failures);
    for (;;) {
        __asm__ volatile("wfi");
    }
}
`;

export const cDrills: Exercise = {
  id: 'c-drills',
  title: 'C drills',
  summary: 'The whiteboard classics: bit tricks and a ring buffer',
  brief:
    'Implement the functions declared in `drills.h`: count set bits, reverse the bits of a word, swap byte order, test for a power of two, update a register field, and a small byte FIFO.\n\n' +
    'A test harness calls your functions on the simulated chip and prints the results to the serial console.',
  background:
    'These are the small functions interviewers ask you to write on a whiteboard, because they show whether bit manipulation is second nature.\n\n' +
    'Useful identities: `x & (x - 1)` clears the lowest set bit (so it is zero exactly for powers of two, and looping on it counts the set bits in as many steps as there are ones). ' +
    'A field update is always clear-then-set: `(reg & ~(mask << shift)) | ((value & mask) << shift)`; masking the value protects the neighbouring bits from an out-of-range argument.\n\n' +
    'Always use unsigned types and unsigned constants (`1u`) for bit work: right-shifting a negative signed value and left-shifting into the sign bit are both traps. ' +
    'Endianness: ARM Cortex-M is little-endian (lowest byte at the lowest address), network protocols are big-endian, which is why byte swapping comes up.\n\n' +
    'For the ring buffer, be ready to explain how you distinguish full from empty (keep one slot free, or keep a count, or let the indices run freely and mask on access) and why a power-of-two size is convenient.',
  devices: ['console'],
  support: { 'drills.h': DRILLS_H, 'harness.c': DRILLS_HARNESS },
  starter: {
    'drills.c': c`#include "drills.h"

uint32_t count_set_bits(uint32_t x)
{
    (void)x;
    return 0;   /* TODO */
}

uint32_t reverse_bits(uint32_t x)
{
    return x;   /* TODO */
}

uint32_t swap_endian32(uint32_t x)
{
    return x;   /* TODO */
}

bool is_power_of_two(uint32_t x)
{
    (void)x;
    return false;   /* TODO */
}

uint32_t set_field(uint32_t reg, uint32_t mask, uint32_t shift, uint32_t value)
{
    (void)mask;
    (void)shift;
    (void)value;
    return reg;     /* TODO */
}

void ring_init(ring_t *r)
{
    (void)r;        /* TODO */
}

bool ring_put(ring_t *r, uint8_t byte)
{
    (void)r;
    (void)byte;
    return false;   /* TODO */
}

bool ring_get(ring_t *r, uint8_t *byte)
{
    (void)r;
    (void)byte;
    return false;   /* TODO */
}

uint32_t ring_count(const ring_t *r)
{
    (void)r;
    return 0;       /* TODO */
}
`,
  },
  solution: {
    'drills.c': c`#include "drills.h"

/* Kernighan's method: each pass clears the lowest set bit. */
uint32_t count_set_bits(uint32_t x)
{
    uint32_t count = 0;
    while (x != 0u) {
        x &= x - 1u;
        count++;
    }
    return count;
}

uint32_t reverse_bits(uint32_t x)
{
    uint32_t result = 0;
    for (uint32_t i = 0; i < 32u; i++) {
        result = (result << 1) | (x & 1u);
        x >>= 1;
    }
    return result;
}

uint32_t swap_endian32(uint32_t x)
{
    return (x << 24) | ((x & 0x0000FF00u) << 8) | ((x >> 8) & 0x0000FF00u) | (x >> 24);
}

/* A power of two has exactly one bit set, so clearing the lowest set bit leaves zero. */
bool is_power_of_two(uint32_t x)
{
    return x != 0u && (x & (x - 1u)) == 0u;
}

uint32_t set_field(uint32_t reg, uint32_t mask, uint32_t shift, uint32_t value)
{
    return (reg & ~(mask << shift)) | ((value & mask) << shift);
}

/* One slot stays empty so that head == tail can only mean "empty". */
void ring_init(ring_t *r)
{
    r->head = 0;
    r->tail = 0;
}

bool ring_put(ring_t *r, uint8_t byte)
{
    uint32_t next = (r->head + 1u) & (RING_SIZE - 1u);
    if (next == r->tail) {
        return false;
    }
    r->data[r->head] = byte;
    r->head = next;
    return true;
}

bool ring_get(ring_t *r, uint8_t *byte)
{
    if (r->head == r->tail) {
        return false;
    }
    *byte = r->data[r->tail];
    r->tail = (r->tail + 1u) & (RING_SIZE - 1u);
    return true;
}

uint32_t ring_count(const ring_t *r)
{
    return (r->head - r->tail) & (RING_SIZE - 1u);
}
`,
  },
  check(ctx) {
    ctx.run(0.6);
    const text = ctx.serial();
    const groups = ['count_set_bits', 'reverse_bits', 'swap_endian32', 'is_power_of_two', 'set_field', 'ring buffer'];
    const lines = text.split('\n');
    const fails = lines.filter((l) => l.startsWith('FAIL '));
    for (const g of groups) {
      const pass = lines.includes(`PASS ${g}`);
      const prefix = g === 'ring buffer' ? ['ring', 'new ring', 'put', 'get', 'count', 'bytes', 'empty', 'order', 'drained', 'lap'] : [g];
      const firstFail = fails.find((l) => prefix.some((p) => l.startsWith(`FAIL ${p}`)));
      ctx.expect(g, pass, pass ? 'all cases pass' : firstFail ? firstFail.slice(5) : 'did not finish');
    }
    ctx.expect('Harness ran to the end', /END \d+/.test(text), /END \d+/.test(text) ? 'finished' : 'the harness did not finish (crash or endless loop in one of the functions?)');
  },
};
