/** Exercises 5-8: external interrupts, timer interrupts, PWM, ADC to servo. */
import { Led, Pot, Servo } from '../board/devices';
import { fmt, near, wave } from './runner';
import { Exercise } from './types';

const c = String.raw;

export const exti: Exercise = {
  id: 'exti',
  refs: ['RCC.APB2ENR', 'SYSCFG.EXTICR', 'EXTI.FTSR', 'EXTI.IMR', 'EXTI.PR', 'NVIC_EnableIRQ'],
  sources: ['rm', 'pm'],
  title: 'External interrupt',
  summary: 'React to a button edge with EXTI instead of polling',
  brief:
    'Toggle the on-board LED (`PA5`) each time the on-board button (`PC13`) is pressed, using an external interrupt on the falling edge.\n\n' +
    'The main loop only increments `idle_count`. It must keep running freely, so do not poll the button there.',
  background:
    'The path from a pin to your handler has four switches, and an interviewer will expect you to name them: ' +
    '(1) `SYSCFG->EXTICR` selects which port drives EXTI line 13 (and SYSCFG needs its own clock), ' +
    '(2) `EXTI->FTSR` / `RTSR` choose the edge, ' +
    '(3) `EXTI->IMR` unmasks the line, ' +
    '(4) `NVIC_EnableIRQ` enables the interrupt in the CPU.\n\n' +
    'Lines 4 to 15 share one handler, `EXTI4_15_IRQHandler`, so check `EXTI->PR` to see which line fired.\n\n' +
    'Inside the handler you must clear the pending flag by writing a 1 to it (`EXTI->PR = EXTI_PR_PR13`). If you forget, the handler is re-entered the moment it returns and main never runs again. ' +
    'Use `=` and not `|=`: OR-ing would also write 1 to every other pending bit and clear interrupts you have not handled yet.',
  devices: ['b1', 'ld2'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/* Incremented by the main loop. Keep this name: the checker reads it. */
volatile uint32_t idle_count;

void EXTI4_15_IRQHandler(void)
{
    /* TODO: confirm line 13 is pending, clear the flag, toggle PA5. */
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOCEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;

    /* TODO 1: clock for SYSCFG, then route port C to EXTI line 13 (SYSCFG->EXTICR[3]). */
    /* TODO 2: falling edge trigger, unmask line 13. */
    /* TODO 3: enable the interrupt in the NVIC. */

    for (;;) {
        idle_count++;
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

volatile uint32_t idle_count;

void EXTI4_15_IRQHandler(void)
{
    if (EXTI->PR & EXTI_PR_PR13) {
        EXTI->PR = EXTI_PR_PR13;            /* write 1 to clear, only this bit */
        GPIOA->ODR ^= 1u << 5;
    }
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOCEN;
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;

    RCC->APB2ENR |= RCC_APB2ENR_SYSCFGCOMPEN;
    SYSCFG->EXTICR[3] = (SYSCFG->EXTICR[3] & ~SYSCFG_EXTICR4_EXTI13) | SYSCFG_EXTICR4_EXTI13_PC;

    EXTI->FTSR |= EXTI_FTSR_TR13;
    EXTI->IMR |= EXTI_IMR_MR13;

    NVIC_EnableIRQ(EXTI4_15_IRQn);

    for (;;) {
        idle_count++;
    }
}
`,
  },
  check(ctx) {
    const led = ctx.board.device<Led>('ld2');
    ctx.run(0.02);
    ctx.expect('LED is off before the first press', !led.lit(), led.lit() ? 'LED is on' : 'LED is off');
    let ok = true;
    let detail = '';
    for (let i = 1; i <= 5 && ok; i++) {
      const before = led.lit();
      ctx.board.button('b1').set(true);
      ctx.run(0.001);
      if (led.lit() === before) {
        ok = false;
        detail = `press ${i}: LED did not change within 1 ms`;
      }
      ctx.run(0.05);
      ctx.board.button('b1').set(false);
      ctx.run(0.05);
      if (ok && led.lit() === before) {
        ok = false;
        detail = `press ${i}: LED changed again on release`;
      }
    }
    ctx.expect('Every press toggles the LED within 1 ms', ok, ok ? '5 presses, 5 toggles' : detail);
    const a = ctx.global('idle_count') ?? 0;
    ctx.run(0.01);
    const b = ctx.global('idle_count') ?? 0;
    ctx.expect(
      'Main loop keeps running after the interrupts',
      b > a && !ctx.hinted('storm'),
      ctx.hinted('storm')
        ? 'the handler is re-entered forever: the pending flag in EXTI->PR is not cleared'
        : b > a
          ? 'idle_count keeps increasing'
          : 'idle_count stopped increasing',
    );
  },
};

export const timerIrq: Exercise = {
  id: 'timer-irq',
  refs: ['RCC.APB1ENR', 'TIM.PSC', 'TIM.ARR', 'TIM.EGR', 'TIM.DIER', 'TIM.SR', 'TIM.CR1', 'NVIC_EnableIRQ'],
  sources: ['rm'],
  title: 'Timer interrupt',
  summary: 'Generate an exact 1 kHz square wave from a timer ISR',
  brief:
    'Produce a 1 kHz square wave on `PC8` (the red LED pin) by toggling the pin in the TIM3 update interrupt.\n\n' +
    'The frequency must be accurate to 0.1 %, which rules out software delay loops.',
  background:
    'A timer counts clock ticks divided by the prescaler: tick rate = timer clock / (`PSC` + 1). It overflows after `ARR` + 1 ticks, which raises the update event. ' +
    'So update rate = 8 MHz / ((PSC + 1) x (ARR + 1)). Both registers are "minus one" values, which is the classic off-by-one in this calculation.\n\n' +
    'A 1 kHz square wave needs a toggle every 500 us, so the update rate must be 2 kHz.\n\n' +
    'The new prescaler value is only loaded at the next update event, so set `TIM3->EGR = TIM_EGR_UG` once to apply it immediately (that also sets the UIF flag, so clear `SR` before enabling the interrupt).\n\n' +
    'In the handler, clear UIF by writing 0 to it: `TIM3->SR = ~TIM_SR_UIF`. Do not use `&=` here, because the read-modify-write could clear another flag that was set in between.',
  devices: ['led_red'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

void TIM3_IRQHandler(void)
{
    /* TODO: clear the update flag, toggle PC8. */
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOCEN;
    GPIOC->MODER = (GPIOC->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;

    /* TODO: enable the TIM3 clock (RCC->APB1ENR). */
    /* TODO: choose PSC and ARR for a 2 kHz update rate (timer clock is 8 MHz). */
    /* TODO: enable the update interrupt (DIER), the IRQ in the NVIC, then start the counter (CR1). */

    for (;;) {
        __WFI();
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

void TIM3_IRQHandler(void)
{
    if (TIM3->SR & TIM_SR_UIF) {
        TIM3->SR = ~TIM_SR_UIF;             /* flags are cleared by writing 0 */
        GPIOC->ODR ^= 1u << 8;
    }
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOCEN;
    GPIOC->MODER = (GPIOC->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;

    RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;

    TIM3->PSC = 8u - 1u;                    /* 8 MHz / 8 = 1 MHz tick */
    TIM3->ARR = 500u - 1u;                  /* 500 ticks = 500 us -> 2 kHz */
    TIM3->EGR = TIM_EGR_UG;                 /* load PSC now */
    TIM3->SR = 0;                           /* UG set UIF: discard it */

    TIM3->DIER = TIM_DIER_UIE;
    NVIC_EnableIRQ(TIM3_IRQn);
    TIM3->CR1 = TIM_CR1_CEN;

    for (;;) {
        __WFI();
    }
}
`,
  },
  check(ctx) {
    const pin = ctx.trace('PC8');
    ctx.run(0.26);
    const w = wave(pin, 0.05);
    ctx.expect('Frequency is 1 kHz within 0.1 %', near(w.freq, 1000, 1), w.periods ? `measured ${fmt(w.freq, 6)} Hz` : 'PC8 never toggled');
    ctx.expect('Duty cycle is 50 %', w.periods > 0 && near(w.duty, 0.5, 0.01), `high ${fmt(w.duty * 100, 4)} % of the time`);
    ctx.expect('Period is steady (jitter below 1 %)', w.periods > 0 && w.jitter < 0.01, `largest deviation ${fmt(w.jitter * 100, 2)} %`);
    ctx.expect(
      'Main loop is not blocked by an interrupt storm',
      !ctx.hinted('storm'),
      ctx.hinted('storm') ? 'the update flag is never cleared, so the handler runs forever' : 'handler returns normally',
    );
  },
};

export const pwmDim: Exercise = {
  id: 'pwm',
  refs: ['GPIO.MODER', 'GPIO.AFR', 'TIM.PSC', 'TIM.ARR', 'TIM.CCR1', 'TIM.CCMR1', 'TIM.CCER'],
  sources: ['rm', 'ds'],
  title: 'Hardware PWM',
  summary: 'Dim the on-board LED to 25 % with a timer channel',
  brief:
    'Drive the on-board LED (`PA5`) with a 1 kHz PWM signal at 25 % duty cycle, generated entirely by timer hardware.\n\n' +
    'On this chip `PA5` can be connected to TIM2 channel 1 using alternate function 2.',
  background:
    'In PWM mode 1 the output is high while `CNT < CCR` and low for the rest of the period. `ARR` sets the period, `CCR` the pulse width: duty = CCR / (ARR + 1).\n\n' +
    'Three places must agree before a waveform appears on the pin: ' +
    'the pin must be in alternate-function mode (`MODER` = 10) with the right function number in `AFR` (4 bits per pin, `AFR[0]` for pins 0-7); ' +
    'the channel must be in PWM mode (`OCxM` = 110 in `CCMR1`); ' +
    'and the output must be enabled (`CCxE` in `CCER`).\n\n' +
    'Setting the preload bit `OCxPE` makes a new `CCR` value take effect at the next period boundary, which avoids glitches when you change the duty cycle on the fly. ' +
    'Once it runs, the CPU is not involved at all, which is why hardware PWM has no jitter.',
  devices: ['ld2'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN;

    /* TODO 1: enable the TIM2 clock. */
    /* TODO 2: PA5 to alternate-function mode, AF2 (GPIOA->MODER and GPIOA->AFR[0]). */
    /* TODO 3: PSC and ARR for a 1 kHz period, CCR1 for 25 %. */
    /* TODO 4: PWM mode 1 on channel 1 (CCMR1), enable the output (CCER), start the timer. */

    for (;;) {
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;

    /* PA5: alternate function 2 = TIM2_CH1 */
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_1;
    GPIOA->AFR[0] = (GPIOA->AFR[0] & ~(0xFu << (5 * 4))) | (2u << (5 * 4));

    TIM2->PSC = 8u - 1u;                    /* 1 MHz tick */
    TIM2->ARR = 1000u - 1u;                 /* 1 kHz period */
    TIM2->CCR1 = 250u;                      /* 25 % */

    TIM2->CCMR1 = TIM_CCMR1_OC1M_2 | TIM_CCMR1_OC1M_1 | TIM_CCMR1_OC1PE;   /* PWM mode 1, preload */
    TIM2->CCER = TIM_CCER_CC1E;
    TIM2->EGR = TIM_EGR_UG;                 /* load PSC, ARR and CCR1 */
    TIM2->CR1 = TIM_CR1_CEN;

    for (;;) {
    }
}
`,
  },
  check(ctx) {
    const pin = ctx.trace('PA5');
    ctx.run(0.06);
    const port = ctx.mcu.ports.get('A')!;
    ctx.expect(
      'PA5 is driven by the timer (alternate function 2)',
      port.mode(5) === 2 && port.af(5) === 2,
      `PA5 is: ${port.describe(5)}`,
    );
    const w = wave(pin, 0.01);
    ctx.expect('PWM frequency is 1 kHz', near(w.freq, 1000, 10), w.periods ? `measured ${fmt(w.freq, 5)} Hz` : 'no signal on PA5');
    ctx.expect('Duty cycle is 25 %', w.periods > 0 && near(w.duty, 0.25, 0.005), `measured ${fmt(w.duty * 100, 4)} %`);
  },
};

export const servoPot: Exercise = {
  id: 'servo',
  refs: ['ADC.CR', 'ADC.ISR', 'ADC.CHSELR', 'ADC.DR', 'GPIO.AFR', 'TIM.CCMR2', 'TIM.CCR1'],
  sources: ['rm', 'ds'],
  title: 'ADC to servo',
  summary: 'Turn a servo with a potentiometer',
  brief:
    'Read the potentiometer on `PA0` with the ADC and position the servo on `PB10` to match: pot fully left = 1.0 ms pulse (0 degrees), fully right = 2.0 ms pulse (180 degrees).\n\n' +
    'A hobby servo expects one pulse every 20 ms (50 Hz). `PB10` is TIM2 channel 3 on alternate function 2.',
  background:
    'This is the complete sensor-to-actuator chain, and it combines two peripherals.\n\n' +
    'ADC start-up on the STM32F0 is a fixed ritual: calibrate (`ADCAL`, wait until it clears), enable (`ADEN`, wait for `ADRDY`), select the channel in `CHSELR`, then for each sample set `ADSTART` and wait for `EOC`. The pin should be in analog mode (`MODER` = 11). The result is 12 bits: 0 to 4095.\n\n' +
    'For the servo, a 1 MHz timer tick (PSC = 7) makes the numbers easy: ARR = 19999 gives 20 ms, and CCR is directly the pulse width in microseconds. ' +
    'Scale with integers: `1000 + raw * 1000 / 4095`. Multiply before dividing or you lose all the resolution, and check that the intermediate value fits in 32 bits (4095 x 1000 does).',
  devices: ['pot', 'servo'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

/* TODO: return one 12-bit conversion of channel 0 (PA0). */
static uint16_t adc_read(void)
{
    return 0;
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN;

    /* TODO 1: ADC clock, PA0 analog, calibrate, enable, select channel 0. */
    /* TODO 2: TIM2 clock, PB10 as AF2, 50 Hz PWM on channel 3. */

    for (;;) {
        uint16_t raw = adc_read();
        /* TODO 3: map raw 0..4095 to a pulse width of 1000..2000 us. */
        (void)raw;
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

static uint16_t adc_read(void)
{
    ADC1->CR |= ADC_CR_ADSTART;
    while (!(ADC1->ISR & ADC_ISR_EOC)) {
    }
    return (uint16_t)ADC1->DR;              /* reading DR clears EOC */
}

int main(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN;
    RCC->APB2ENR |= RCC_APB2ENR_ADCEN;
    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;

    /* ADC: PA0 analog, calibrate, enable, channel 0 */
    GPIOA->MODER |= GPIO_MODER_MODER0;
    ADC1->CR |= ADC_CR_ADCAL;
    while (ADC1->CR & ADC_CR_ADCAL) {
    }
    ADC1->CR |= ADC_CR_ADEN;
    while (!(ADC1->ISR & ADC_ISR_ADRDY)) {
    }
    ADC1->CHSELR = ADC_CHSELR_CHSEL0;

    /* PB10: alternate function 2 = TIM2_CH3 (pins 8..15 live in AFR[1]) */
    GPIOB->MODER = (GPIOB->MODER & ~GPIO_MODER_MODER10) | GPIO_MODER_MODER10_1;
    GPIOB->AFR[1] = (GPIOB->AFR[1] & ~(0xFu << ((10 - 8) * 4))) | (2u << ((10 - 8) * 4));

    TIM2->PSC = 8u - 1u;                    /* 1 MHz: one tick = 1 us */
    TIM2->ARR = 20000u - 1u;                /* 20 ms period */
    TIM2->CCR3 = 1500u;
    TIM2->CCMR2 = TIM_CCMR2_OC3M_2 | TIM_CCMR2_OC3M_1 | TIM_CCMR2_OC3PE;
    TIM2->CCER = TIM_CCER_CC3E;
    TIM2->EGR = TIM_EGR_UG;
    TIM2->CR1 = TIM_CR1_CEN;

    for (;;) {
        uint32_t raw = adc_read();
        TIM2->CCR3 = 1000u + (raw * 1000u) / 4095u;
    }
}
`,
  },
  check(ctx) {
    const pot = ctx.board.device<Pot>('pot');
    const servo = ctx.board.device<Servo>('servo');
    const steps: Array<[number, number]> = [[0, 1.0], [0.5, 1.5], [1, 2.0], [0.25, 1.25]];
    let periodOk = true;
    let periodDetail = '';
    for (const [pos, wantMs] of steps) {
      pot.input('pos', pos);
      ctx.run(0.12);
      const s = servo.signal();
      if (!near(s.periodMs, 20, 0.2)) {
        periodOk = false;
        periodDetail = s.periodMs > 0 ? `period is ${fmt(s.periodMs, 4)} ms` : 'no pulses on PB10';
      }
      ctx.expect(
        `Pot at ${Math.round(pos * 100)} % gives a ${wantMs.toFixed(2)} ms pulse`,
        near(s.pulseMs, wantMs, 0.02),
        s.pulseMs > 0 ? `measured ${fmt(s.pulseMs, 4)} ms` : 'no pulses on PB10',
      );
    }
    ctx.expect('Pulses repeat every 20 ms (50 Hz)', periodOk, periodOk ? '20 ms period' : periodDetail);
    ctx.expect(
      'PA0 is in analog mode',
      !ctx.hinted('adc:mode'),
      ctx.hinted('adc:mode') ? 'PA0 is still a digital input' : 'MODER = 11',
    );
  },
};
