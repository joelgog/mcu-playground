/** Exercises 9-12: ADC with hysteresis, input capture, shared data, state machine. */
import { Hcsr04, Led, TempSensor } from '../board/devices';
import { fmt, near, wave } from './runner';
import { Exercise } from './types';

const c = String.raw;

export const thermostat: Exercise = {
  id: 'thermostat',
  refs: ['RCC.APB2ENR', 'ADC.CR', 'ADC.ISR', 'ADC.CHSELR', 'ADC.SMPR', 'ADC.DR'],
  sources: ['rm', 'mcp9700'],
  title: 'ADC and hysteresis',
  summary: 'Fixed-point temperature and an alarm that does not flicker',
  brief:
    'Read the analog temperature sensor on `PA1` (500 mV at 0 C, plus 10 mV per degree) and store the temperature in tenths of a degree in `temperature_x10` (22.5 C is 225). Use integer math only.\n\n' +
    'Switch the red LED (`PC8`) on when it gets to 30.0 C or hotter, and off again only when it has cooled to 28.0 C or below.',
  background:
    'A Cortex-M0 has no floating-point unit, so `float` math is done by slow library code. Embedded code works in scaled integers instead: millivolts, tenths of a degree.\n\n' +
    'Convert in two steps: `mv = raw * 3300 / 4095`, then `tenths = mv - 500` (10 mV per degree means 1 mV per tenth). Order matters: multiply first, divide last, and make sure the intermediate product fits in 32 bits.\n\n' +
    'A single threshold would make the output chatter when the reading hovers around it, because every ADC has a little noise. Hysteresis uses two thresholds and keeps the previous state in the band between them. ' +
    'The same idea appears in thermostats, battery monitors and Schmitt-trigger inputs.',
  devices: ['temp', 'led_red'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/* Temperature in tenths of a degree Celsius. Keep this name: the checker reads it. */
volatile int32_t temperature_x10;

/* TODO: return one 12-bit conversion of channel 1 (PA1). */
static uint16_t adc_read(void)
{
    return 0;
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOCEN;
    GPIOC->MODER = (GPIOC->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;

    /* TODO: ADC clock, PA1 analog, calibrate, enable, select channel 1. */

    for (;;) {
        uint16_t raw = adc_read();
        /* TODO: raw -> millivolts -> tenths of a degree, then the alarm with hysteresis. */
        (void)raw;
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

#define ALARM_ON_X10  300   /* 30.0 C */
#define ALARM_OFF_X10 280   /* 28.0 C */

volatile int32_t temperature_x10;

static uint16_t adc_read(void)
{
    ADC1->CR |= ADC_CR_ADSTART;
    while (!(ADC1->ISR & ADC_ISR_EOC)) {
    }
    return (uint16_t)ADC1->DR;
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOCEN;
    GPIOC->MODER = (GPIOC->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;

    RCC->APB2ENR |= RCC_APB2ENR_ADCEN;
    GPIOA->MODER |= GPIO_MODER_MODER1;      /* PA1 analog */
    ADC1->CR |= ADC_CR_ADCAL;
    while (ADC1->CR & ADC_CR_ADCAL) {
    }
    ADC1->CR |= ADC_CR_ADEN;
    while (!(ADC1->ISR & ADC_ISR_ADRDY)) {
    }
    ADC1->CHSELR = ADC_CHSELR_CHSEL1;
    ADC1->SMPR = ADC_SMPR_SMP_2 | ADC_SMPR_SMP_1 | ADC_SMPR_SMP_0;   /* longest sampling time */

    for (;;) {
        uint32_t raw = adc_read();
        int32_t millivolts = (int32_t)((raw * 3300u) / 4095u);
        int32_t tenths = millivolts - 500;  /* 10 mV per degree = 1 mV per tenth */

        temperature_x10 = tenths;

        if (tenths >= ALARM_ON_X10) {
            GPIOC->BSRR = 1u << 8;
        } else if (tenths <= ALARM_OFF_X10) {
            GPIOC->BSRR = 1u << (8 + 16);
        }
        /* between the thresholds: keep the previous state */
    }
}
`,
  },
  check(ctx) {
    const sensor = ctx.board.device<TempSensor>('temp');
    const led = ctx.board.device<Led>('led_red');
    const set = (t: number) => {
      sensor.input('tempC', t);
      ctx.run(0.03);
    };
    set(22);
    const t22 = ctx.global('temperature_x10');
    ctx.expect('22.0 C reads as about 220', t22 !== null && near(t22 | 0, 220, 4), t22 === null ? 'variable temperature_x10 not found' : `temperature_x10 = ${t22 | 0}`);
    set(-5);
    const tNeg = ctx.global('temperature_x10');
    ctx.expect('-5.0 C reads as about -50 (signed)', tNeg !== null && near(tNeg | 0, -50, 4), `temperature_x10 = ${tNeg === null ? '?' : tNeg | 0}`);
    set(22);
    ctx.expect('Alarm off at 22 C', !led.lit(), led.lit() ? 'LED on' : 'LED off');
    set(31);
    ctx.expect('Alarm on at 31 C', led.lit(), led.lit() ? 'LED on' : 'LED off');
    set(29);
    ctx.expect('Alarm stays on when cooling to 29 C', led.lit(), led.lit() ? 'LED still on' : 'LED went off inside the hysteresis band');
    set(27.5);
    ctx.expect('Alarm off at 27.5 C', !led.lit(), led.lit() ? 'LED on' : 'LED off');
    set(29);
    ctx.expect('Alarm stays off when warming to 29 C', !led.lit(), led.lit() ? 'LED came on inside the hysteresis band' : 'LED still off');
  },
};

export const sonar: Exercise = {
  id: 'input-capture',
  refs: ['GPIO.AFR', 'TIM.CCMR1', 'TIM.CCER', 'TIM.SR', 'TIM.CCR1', 'TIM.CNT'],
  sources: ['rm', 'ds'],
  title: 'Input capture',
  summary: 'Measure distance with an ultrasonic sensor',
  brief:
    'Measure distance with the ultrasonic sensor and keep the latest result in `distance_cm`.\n\n' +
    'Send a trigger pulse of at least 10 us on `PA8`. The sensor answers on `PB3` with a high pulse whose length is 58 us per centimetre. `PB3` is TIM2 channel 2 on alternate function 2. Measure about 15 times per second.',
  background:
    'Timing a pulse by polling a GPIO pin in a loop is only as accurate as the loop. Input capture lets the timer hardware copy the counter into `CCR` at the exact instant of the edge, so the software only has to pick the numbers up afterwards.\n\n' +
    'Configure the channel as an input (`CC2S` = 01 in `CCMR1`), choose the edges with `CC2P`/`CC2NP` in `CCER` (both set = both edges), and enable it with `CC2E`. Each capture sets `CC2IF`; reading `CCR2` clears it.\n\n' +
    'With a 1 MHz timer tick the difference between the falling and rising capture is the pulse width in microseconds. Unsigned subtraction gives the right answer even if the counter wrapped in between. ' +
    'Always give a wait loop a timeout: if the sensor is unplugged, the firmware must not hang forever.',
  devices: ['sonar'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/* Latest measurement in centimetres. Keep this name: the checker reads it. */
volatile uint32_t distance_cm;

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN;
    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;

    /* PA8: trigger output */
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;

    /* TIM2 as a free-running microsecond counter (32 bit) */
    TIM2->PSC = 8u - 1u;
    TIM2->EGR = TIM_EGR_UG;
    TIM2->CR1 = TIM_CR1_CEN;

    /* TODO 1: PB3 to AF2, TIM2 channel 2 as input capture on both edges. */

    for (;;) {
        /* TODO 2: 10 us trigger pulse on PA8 (TIM2->CNT counts microseconds). */
        /* TODO 3: capture the rising and the falling edge, with a timeout. */
        /* TODO 4: distance_cm = pulse width in us / 58. Then wait about 60 ms. */
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

volatile uint32_t distance_cm;

/* TIM2 runs at 1 MHz, so CNT is a microsecond clock. */
static void wait_us(uint32_t us)
{
    uint32_t start = TIM2->CNT;
    while ((TIM2->CNT - start) < us) {
    }
}

/* Wait for the next capture on channel 2. Returns 0 on timeout. */
static int wait_capture(uint32_t *value, uint32_t timeout_us)
{
    uint32_t start = TIM2->CNT;
    while (!(TIM2->SR & TIM_SR_CC2IF)) {
        if ((TIM2->CNT - start) > timeout_us) {
            return 0;
        }
    }
    *value = TIM2->CCR2;                    /* reading CCR2 clears CC2IF */
    return 1;
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN;
    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;

    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;

    /* PB3: alternate function 2 = TIM2_CH2 */
    GPIOB->MODER = (GPIOB->MODER & ~GPIO_MODER_MODER3) | GPIO_MODER_MODER3_1;
    GPIOB->AFR[0] = (GPIOB->AFR[0] & ~(0xFu << (3 * 4))) | (2u << (3 * 4));

    TIM2->PSC = 8u - 1u;
    TIM2->CCMR1 = TIM_CCMR1_CC2S_0;                                 /* channel 2 = input, mapped to TI2 */
    TIM2->CCER = TIM_CCER_CC2E | TIM_CCER_CC2P | TIM_CCER_CC2NP;    /* capture on both edges */
    TIM2->EGR = TIM_EGR_UG;
    TIM2->CR1 = TIM_CR1_CEN;

    for (;;) {
        uint32_t rise;
        uint32_t fall;

        (void)TIM2->CCR2;                   /* discard any stale capture */
        TIM2->SR = 0;

        GPIOA->BSRR = 1u << 8;
        wait_us(12);
        GPIOA->BSRR = 1u << (8 + 16);

        if (wait_capture(&rise, 5000u) && wait_capture(&fall, 40000u)) {
            distance_cm = (fall - rise + 29u) / 58u;    /* rounded */
        }

        wait_us(60000u);
    }
}
`,
  },
  check(ctx) {
    const s = ctx.board.device<Hcsr04>('sonar');
    const cases: Array<[number, number]> = [[50, 1], [123, 2], [7, 1], [300, 3]];
    for (const [cm, tol] of cases) {
      s.input('distanceCm', cm);
      const before = s.measurements;
      ctx.run(0.3);
      const got = ctx.global('distance_cm');
      ctx.expect(
        `Object at ${cm} cm is measured correctly`,
        got !== null && near(got, cm, tol) && s.measurements > before,
        s.measurements === before ? 'the sensor was not triggered' : got === null ? 'variable distance_cm not found' : `distance_cm = ${got}`,
      );
    }
    const rate = s.measurements / 1.2;
    ctx.expect('Measures 5 to 30 times per second', rate >= 5 && rate <= 30, `${fmt(rate, 3)} measurements per second`);
    ctx.expect(
      'Trigger pulse is at least 10 us long',
      !ctx.hinted('hcsr04'),
      ctx.hinted('hcsr04') ? 'trigger pulse too short' : 'trigger accepted',
    );
  },
};

export const sharedData: Exercise = {
  id: 'shared-data',
  refs: ['__disable_irq', '__enable_irq', 'TIM.SR'],
  sources: ['pm', 'arm'],
  title: 'Sharing data with an ISR',
  summary: 'Fix a missing volatile and a torn read',
  brief:
    'This program is built with `-O2` and has two bugs in how the main loop shares data with the timer interrupt. Fix both without changing what the interrupt handler does.\n\n' +
    'Bug 1: `wait_for_batch()` never returns. Bug 2: `take_sample()` sometimes sees `shared.up + shared.down` not equal to zero, although the handler always changes both together.',
  background:
    'These are the two concurrency questions asked in almost every embedded interview.\n\n' +
    'Missing `volatile`: the compiler sees a loop that reads `data_ready` but never writes it, concludes the value cannot change, reads it once and spins forever. It cannot know an interrupt writes the variable. `volatile` forces a real memory read every time. ' +
    'The bug typically only appears with optimisation on, which is why "works in debug, hangs in release" is a classic symptom.\n\n' +
    'Torn read: copying a two-word structure takes two load instructions. If the interrupt fires between them, the copy holds one old and one new field, a state that never existed. `volatile` does not help here. The copy has to be atomic, and on a single-core MCU the simplest tool is a short critical section: `__disable_irq()`, copy, `__enable_irq()`. ' +
    'Keep it as short as possible, because every cycle with interrupts off adds latency. The interrupt is not lost: it stays pending and runs right after.',
  devices: [],
  opt: 'O2',
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/* The handler keeps up + down == 0 at all times. */
typedef struct {
    uint32_t up;
    uint32_t down;
} pair_t;

static volatile pair_t shared;
static uint8_t data_ready;                  /* set by the interrupt, polled by main */

/* Statistics read by the checker: keep these names. */
volatile uint32_t isr_count;
volatile uint32_t batches;
volatile uint32_t samples;
volatile uint32_t violations;

/* 20 kHz timer interrupt. Do not change what it does. */
void TIM3_IRQHandler(void)
{
    TIM3->SR = ~TIM_SR_UIF;
    shared.up++;
    shared.down--;
    isr_count++;
    if ((isr_count % 100u) == 0u) {
        data_ready = 1;
    }
}

static void wait_for_batch(void)
{
    while (!data_ready) {
    }
    data_ready = 0;
    batches++;
}

static void take_sample(void)
{
    pair_t copy;

    copy.up = shared.up;
    copy.down = shared.down;

    if (copy.up + copy.down != 0u) {
        violations++;
    }
    samples++;
}

int main(void)
{
    RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
    TIM3->PSC = 0;
    TIM3->ARR = 400u - 1u;                  /* 8 MHz / 400 = 20 kHz */
    TIM3->DIER = TIM_DIER_UIE;
    NVIC_EnableIRQ(TIM3_IRQn);
    TIM3->CR1 = TIM_CR1_CEN;

    for (;;) {
        wait_for_batch();
        for (uint32_t i = 0; i < 1000u; i++) {
            take_sample();
        }
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

typedef struct {
    uint32_t up;
    uint32_t down;
} pair_t;

static volatile pair_t shared;
static volatile uint8_t data_ready;         /* FIX 1: volatile, it changes behind the compiler's back */

volatile uint32_t isr_count;
volatile uint32_t batches;
volatile uint32_t samples;
volatile uint32_t violations;

void TIM3_IRQHandler(void)
{
    TIM3->SR = ~TIM_SR_UIF;
    shared.up++;
    shared.down--;
    isr_count++;
    if ((isr_count % 100u) == 0u) {
        data_ready = 1;
    }
}

static void wait_for_batch(void)
{
    while (!data_ready) {
    }
    data_ready = 0;
    batches++;
}

static void take_sample(void)
{
    pair_t copy;

    /* FIX 2: both fields must come from the same instant -> short critical section */
    __disable_irq();
    copy.up = shared.up;
    copy.down = shared.down;
    __enable_irq();

    if (copy.up + copy.down != 0u) {
        violations++;
    }
    samples++;
}

int main(void)
{
    RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
    TIM3->PSC = 0;
    TIM3->ARR = 400u - 1u;
    TIM3->DIER = TIM_DIER_UIE;
    NVIC_EnableIRQ(TIM3_IRQn);
    TIM3->CR1 = TIM_CR1_CEN;

    for (;;) {
        wait_for_batch();
        for (uint32_t i = 0; i < 1000u; i++) {
            take_sample();
        }
    }
}
`,
  },
  check(ctx) {
    ctx.run(1.0);
    const batches = ctx.global('batches') ?? 0;
    const samples = ctx.global('samples') ?? 0;
    const violations = ctx.global('violations') ?? 0;
    const isr = ctx.global('isr_count') ?? 0;
    ctx.expect(
      'wait_for_batch() returns (flag is re-read from memory)',
      batches >= 150,
      batches === 0 ? 'main is stuck in wait_for_batch(): the flag was read once and cached' : `${batches} batches in 1 s`,
    );
    ctx.expect(
      'No torn reads of the shared pair',
      samples > 1000 && violations === 0,
      samples <= 1000 ? `only ${samples} samples taken` : `${violations} of ${samples} samples were inconsistent`,
    );
    ctx.expect(
      'The interrupt still runs at 20 kHz',
      near(isr, 20000, 200),
      `${isr} interrupts in 1 s${isr < 19800 ? ' (interrupts disabled for too long?)' : ''}`,
    );
  },
};

export const trafficLight: Exercise = {
  id: 'state-machine',
  refs: ['SysTick_Config', 'GPIO.BSRR', 'GPIO.IDR', 'GPIO.PUPDR'],
  sources: ['rm'],
  title: 'State machine',
  summary: 'A pedestrian crossing that never blocks',
  brief:
    'Build a traffic light with the red (`PC8`), yellow (`PC9`) and green (`PC10`) LEDs. It rests on green. When Button A (`PB8`) is pressed it runs once through: yellow for 1 s, red for 3 s, red and yellow together for 1 s, then back to green. Presses during the sequence are ignored.\n\n' +
    'All the while the on-board LED (`PA5`) must keep toggling every 100 ms as a heartbeat, so the sequence cannot be written with blocking delays.',
  background:
    'Asked to "design the firmware for X", a strong candidate reaches for a state machine: a variable holding the current state, and a `switch` that, for each state, sets the outputs and decides when to move on.\n\n' +
    'Each state records the time it was entered; the main loop compares the elapsed time on every pass and transitions when it is due. Nothing ever waits, so other work (the heartbeat here; communication, sensors or a watchdog kick in real products) keeps running.\n\n' +
    'Things reviewers look for: an `enum` for the states, a single place where outputs are set per state, no magic numbers for the durations, and unsigned `now - entered >= duration` comparisons that survive counter wrap-around. ' +
    'The button needs its pull-up; debouncing is not required here because presses during the sequence are ignored anyway.',
  devices: ['led_red', 'led_yellow', 'led_green', 'sw1', 'ld2'],
  deviceOptions: { sw1: { bounceMs: 5 } },
  starter: {
    'main.c': c`#include "stm32f0xx.h"

static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}

/* Provided: set the three lights (1 = on). */
static void set_lights(int red, int yellow, int green)
{
    GPIOC->BSRR = (red ? 1u << 8 : 1u << 24) | (yellow ? 1u << 9 : 1u << 25) | (green ? 1u << 10 : 1u << 26);
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN | RCC_AHBENR_GPIOCEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
    GPIOC->MODER = (GPIOC->MODER & ~(0x3Fu << 16)) | (0x15u << 16);             /* PC8..PC10 outputs */
    GPIOB->PUPDR = (GPIOB->PUPDR & ~GPIO_PUPDR_PUPDR8) | GPIO_PUPDR_PUPDR8_0;   /* button pull-up */
    SysTick_Config(SystemCoreClock / 1000u);

    set_lights(0, 0, 1);

    for (;;) {
        /* TODO: heartbeat on PA5 every 100 ms. */
        /* TODO: state machine  GREEN -> YELLOW (1 s) -> RED (3 s) -> RED+YELLOW (1 s) -> GREEN. */
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

#define HEARTBEAT_MS   100u
#define YELLOW_MS     1000u
#define RED_MS        3000u
#define RED_YELLOW_MS 1000u

typedef enum { ST_GREEN, ST_YELLOW, ST_RED, ST_RED_YELLOW } state_t;

static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}

static void set_lights(int red, int yellow, int green)
{
    GPIOC->BSRR = (red ? 1u << 8 : 1u << 24) | (yellow ? 1u << 9 : 1u << 25) | (green ? 1u << 10 : 1u << 26);
}

static int button_pressed(void)
{
    return (GPIOB->IDR & (1u << 8)) == 0u;  /* active low */
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN | RCC_AHBENR_GPIOCEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
    GPIOC->MODER = (GPIOC->MODER & ~(0x3Fu << 16)) | (0x15u << 16);
    GPIOB->PUPDR = (GPIOB->PUPDR & ~GPIO_PUPDR_PUPDR8) | GPIO_PUPDR_PUPDR8_0;
    SysTick_Config(SystemCoreClock / 1000u);

    state_t state = ST_GREEN;
    uint32_t entered = 0;
    uint32_t last_beat = 0;

    set_lights(0, 0, 1);

    for (;;) {
        uint32_t now = ms_ticks;

        if (now - last_beat >= HEARTBEAT_MS) {
            last_beat += HEARTBEAT_MS;
            GPIOA->ODR ^= 1u << 5;
        }

        switch (state) {
        case ST_GREEN:
            if (button_pressed()) {
                state = ST_YELLOW;
                entered = now;
                set_lights(0, 1, 0);
            }
            break;
        case ST_YELLOW:
            if (now - entered >= YELLOW_MS) {
                state = ST_RED;
                entered = now;
                set_lights(1, 0, 0);
            }
            break;
        case ST_RED:
            if (now - entered >= RED_MS) {
                state = ST_RED_YELLOW;
                entered = now;
                set_lights(1, 1, 0);
            }
            break;
        case ST_RED_YELLOW:
            if (now - entered >= RED_YELLOW_MS) {
                state = ST_GREEN;
                entered = now;
                set_lights(0, 0, 1);
            }
            break;
        }
    }
}
`,
  },
  check(ctx) {
    const lit = (id: string) => (ctx.board.device<Led>(id).lit() ? '1' : '0');
    const lights = () => lit('led_red') + lit('led_yellow') + lit('led_green');
    const name = (p: string) => `red=${p[0]} yellow=${p[1]} green=${p[2]}`;
    const beat = ctx.trace('PA5');
    ctx.run(0.5);
    let p = lights();
    ctx.expect('Rests on green', p === '001', name(p));
    const t0 = ctx.mcu.clock.seconds();
    const until = (t: number) => ctx.run(t0 + t - ctx.mcu.clock.seconds());
    ctx.board.button('sw1').set(true);
    until(0.08);
    ctx.board.button('sw1').set(false);
    until(0.5);
    p = lights();
    ctx.expect('Yellow after the button press', p === '010', `0.5 s after the press: ${name(p)}`);
    until(1.5);
    p = lights();
    ctx.expect('Red after 1 s of yellow', p === '100', `1.5 s after the press: ${name(p)}`);
    ctx.press('sw1', 80);
    until(3.5);
    p = lights();
    ctx.expect('Still red at 3.5 s; a press during the sequence is ignored', p === '100', `3.5 s after the press: ${name(p)}`);
    until(4.5);
    p = lights();
    ctx.expect('Red and yellow together after 3 s of red', p === '110', `4.5 s after the press: ${name(p)}`);
    until(5.5);
    p = lights();
    ctx.expect('Back to green after 1 s', p === '001', `5.5 s after the press: ${name(p)}`);
    until(6.5);
    p = lights();
    ctx.expect('Stays green until the next press', p === '001', `6.5 s after the press: ${name(p)}`);
    const w = wave(beat, 0.3);
    ctx.expect(
      'Heartbeat keeps toggling every 100 ms throughout',
      near(w.freq, 5, 0.1) && w.jitter < 0.1,
      w.periods === 0 ? 'PA5 never toggled' : `${fmt(w.freq, 4)} Hz, largest gap deviation ${fmt(w.jitter * 100, 2)} %`,
    );
  },
};
