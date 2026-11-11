/** Peripheral behaviour and timing, exercised with real firmware compiled by arm-none-eabi-gcc. */
import { describe, expect, it } from 'vitest';
import { compile } from '../server/toolchain';
import { Net } from '../src/board/net';
import { Mcu } from '../src/emu/mcu';

async function boot(main: string, opt: 'Og' | 'O2' = 'Og'): Promise<Mcu> {
  const res = await compile([{ name: 'main.c', content: `#include "stm32f0xx.h"\n#include <stdio.h>\n${main}` }], { opt });
  if (!res.ok || !res.elf) throw new Error(res.log);
  const mcu = new Mcu();
  mcu.load(res.elf);
  return mcu;
}

function rises(net: Net): number[] {
  const out: number[] = [];
  for (let i = 1; i < net.traceT.length; i++) {
    if (net.traceV[i] > 1.65 && net.traceV[i - 1] <= 1.65) out.push(net.traceT[i]);
  }
  return out;
}
function falls(net: Net): number[] {
  const out: number[] = [];
  for (let i = 1; i < net.traceT.length; i++) {
    if (net.traceV[i] <= 1.65 && net.traceV[i - 1] > 1.65) out.push(net.traceT[i]);
  }
  return out;
}
const hintIds = (mcu: Mcu) => mcu.hints.map((h) => h.id);

const SYSTICK_DELAY = `
static volatile uint32_t ticks;
void SysTick_Handler(void) { ticks++; }
static void delay_ms(uint32_t ms) { uint32_t start = ticks; while ((ticks - start) < ms) { } }
`;

describe('GPIO, RCC and SysTick', () => {
  it('blinks PA5 at exactly 1 Hz using a SysTick time base', async () => {
    const mcu = await boot(`${SYSTICK_DELAY}
      int main(void) {
        RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
        GPIOA->MODER |= GPIO_MODER_MODER5_0;
        SysTick_Config(SystemCoreClock / 1000);
        for (;;) { GPIOA->ODR ^= 1u << 5; delay_ms(500); }
      }`);
    const led = mcu.net('PA5');
    led.startTrace();
    mcu.runSeconds(3.2);
    const r = rises(led);
    expect(r.length).toBe(4);
    for (let i = 1; i < r.length; i++) expect(r[i] - r[i - 1]).toBeCloseTo(1.0, 4);
    expect(mcu.hints).toEqual([]);
  });

  it('ignores GPIO writes and explains why when the port clock is off', async () => {
    const mcu = await boot(`
      int main(void) {
        GPIOA->MODER |= GPIO_MODER_MODER5_0;
        GPIOA->BSRR = 1u << 5;
        for (;;) { }
      }`);
    mcu.runSeconds(0.01);
    expect(mcu.net('PA5').level).toBe(0);
    expect(hintIds(mcu)).toContain('noclk:GPIOA');
  });

  it('BSRR sets and resets atomically, and BRR clears', async () => {
    const mcu = await boot(`
      int main(void) {
        RCC->AHBENR |= RCC_AHBENR_GPIOCEN;
        GPIOC->MODER = 0x5555;
        GPIOC->BSRR = 0x00ff;
        GPIOC->BSRR = (0x0fu << 16) | 0x100u;
        GPIOC->BRR = 0x80;
        for (;;) { }
      }`);
    mcu.runSeconds(0.001);
    expect(mcu.ports.get('C')!.odr).toBe(0x0170);
    expect(mcu.net('PC4').level).toBe(1);
    expect(mcu.net('PC0').level).toBe(0);
    expect(mcu.net('PC8').level).toBe(0); // ODR bit 8 is set, but PC8 is still an input so the pin is not driven
  });

  it('reads a button with the internal pull-up and reports a floating input without it', async () => {
    const src = (pull: string) => `
      volatile uint32_t seen;
      int main(void) {
        RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
        ${pull}
        for (;;) { seen = (GPIOB->IDR >> 8) & 1u; }
      }`;
    const button = {};
    const withPull = await boot(src('GPIOB->PUPDR |= GPIO_PUPDR_PUPDR8_0;'));
    withPull.net('PB8').floatHint = 'button A';
    withPull.runSeconds(0.001);
    expect(withPull.readGlobal('seen')).toBe(1);
    withPull.net('PB8').drive(button, 0);
    withPull.runSeconds(0.001);
    expect(withPull.readGlobal('seen')).toBe(0);
    withPull.net('PB8').drive(button, null);
    withPull.runSeconds(0.001);
    expect(withPull.readGlobal('seen')).toBe(1);
    expect(withPull.hints).toEqual([]);

    const noPull = await boot(src(''));
    noPull.net('PB8').floatHint = 'button A';
    noPull.runSeconds(0.001);
    expect(hintIds(noPull)).toContain('float:PB8');
  });

  it('switches to the 48 MHz oscillator and keeps real time', async () => {
    const mcu = await boot(`${SYSTICK_DELAY}
      int main(void) {
        FLASH->ACR |= FLASH_ACR_LATENCY;
        RCC->CR2 |= RCC_CR2_HSI48ON;
        while (!(RCC->CR2 & RCC_CR2_HSI48RDY)) { }
        RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_SW) | RCC_CFGR_SW_HSI48;
        while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_HSI48) { }
        SystemCoreClockUpdate();
        RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
        GPIOA->MODER |= GPIO_MODER_MODER5_0;
        SysTick_Config(SystemCoreClock / 1000);
        for (;;) { GPIOA->ODR ^= 1u << 5; delay_ms(10); }
      }`);
    const led = mcu.net('PA5');
    led.startTrace();
    mcu.runSeconds(0.1);
    expect(mcu.clock.hz).toBe(48_000_000);
    const r = rises(led);
    expect(r.length).toBeGreaterThanOrEqual(4);
    expect(r[2] - r[1]).toBeCloseTo(0.02, 5);
    expect(mcu.hints).toEqual([]);
  });

  it('sleeps in WFI between SysTick interrupts', async () => {
    const mcu = await boot(`
      volatile uint32_t ticks;
      void SysTick_Handler(void) { ticks++; }
      int main(void) {
        SysTick_Config(SystemCoreClock / 1000);
        for (;;) { __WFI(); }
      }`);
    mcu.runSeconds(1.0005);
    expect(mcu.readGlobal('ticks')).toBe(1000);
    expect(mcu.cpu.sleepCycles / mcu.clock.cycles).toBeGreaterThan(0.99);
  });
});

describe('timers', () => {
  it('generates 1 kHz PWM with 25% duty on TIM3_CH3 (PC8)', async () => {
    const mcu = await boot(`
      int main(void) {
        RCC->AHBENR |= RCC_AHBENR_GPIOCEN;
        RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
        GPIOC->MODER |= GPIO_MODER_MODER8_1;            /* AF0 = TIM3_CH3 */
        TIM3->PSC = 7;                                  /* 8 MHz / 8 = 1 MHz */
        TIM3->ARR = 999;                                /* 1 kHz */
        TIM3->CCR3 = 250;
        TIM3->CCMR2 = TIM_CCMR2_OC3M_2 | TIM_CCMR2_OC3M_1 | TIM_CCMR2_OC3PE;
        TIM3->CCER = TIM_CCER_CC3E;
        TIM3->EGR = TIM_EGR_UG;
        TIM3->CR1 = TIM_CR1_CEN;
        for (;;) { }
      }`);
    const pin = mcu.net('PC8');
    pin.startTrace();
    mcu.runSeconds(0.0205);
    const r = rises(pin);
    const f = falls(pin);
    expect(r.length).toBe(21); // one edge when the output is enabled, then one per millisecond
    expect(r[5] - r[4]).toBeCloseTo(0.001, 9);
    expect(f[5] - r[5]).toBeCloseTo(0.00025, 9);
  });

  it('applies a new prescaler only at the next update event', async () => {
    const mcu = await boot(`
      int main(void) {
        RCC->AHBENR |= RCC_AHBENR_GPIOCEN;
        RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
        GPIOC->MODER |= GPIO_MODER_MODER8_1;
        TIM3->PSC = 7999;                               /* no UG: still counting at 8 MHz until the first overflow */
        TIM3->ARR = 9;
        TIM3->CCR3 = 5;
        TIM3->CCMR2 = TIM_CCMR2_OC3M_2 | TIM_CCMR2_OC3M_1;
        TIM3->CCER = TIM_CCER_CC3E;
        TIM3->CR1 = TIM_CR1_CEN;
        for (;;) { }
      }`);
    const pin = mcu.net('PC8');
    pin.startTrace();
    mcu.runSeconds(0.025);
    const r = rises(pin);
    // first period: 10 ticks at 8 MHz (1.25 us); afterwards 10 ticks at 1 kHz (10 ms)
    expect(r[1] - r[0]).toBeLessThan(0.00001);
    expect(r[2] - r[1]).toBeCloseTo(0.01, 9);
  });

  it('fires the update interrupt at 1 kHz and the handler toggles a pin', async () => {
    const mcu = await boot(`
      void TIM3_IRQHandler(void) {
        TIM3->SR = ~TIM_SR_UIF;
        GPIOA->ODR ^= 1u << 5;
      }
      int main(void) {
        RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
        RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
        GPIOA->MODER |= GPIO_MODER_MODER5_0;
        TIM3->PSC = 0;
        TIM3->ARR = 7999;
        TIM3->DIER = TIM_DIER_UIE;
        NVIC_EnableIRQ(TIM3_IRQn);
        TIM3->CR1 = TIM_CR1_CEN;
        for (;;) { }
      }`);
    const pin = mcu.net('PA5');
    pin.startTrace();
    mcu.runSeconds(0.0505);
    const r = rises(pin);
    expect(r.length).toBe(25);
    expect(r[10] - r[9]).toBeCloseTo(0.002, 6); // within interrupt-latency jitter of a few cycles
    expect(mcu.hints).toEqual([]);
  });

  it('detects an interrupt storm when the handler does not clear its flag', async () => {
    const mcu = await boot(`
      volatile uint32_t main_loops;
      void TIM3_IRQHandler(void) { }
      int main(void) {
        RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
        TIM3->ARR = 7999;
        TIM3->DIER = TIM_DIER_UIE;
        NVIC_EnableIRQ(TIM3_IRQn);
        TIM3->CR1 = TIM_CR1_CEN;
        for (;;) { main_loops++; }
      }`);
    mcu.runSeconds(0.05);
    expect(hintIds(mcu)).toContain('storm:32');
  });

  it('measures an external pulse with input capture on TIM2_CH2 (PB3)', async () => {
    const mcu = await boot(`
      volatile uint32_t rise, width, captures;
      void TIM2_IRQHandler(void) {
        if (TIM2->SR & TIM_SR_CC2IF) {
          uint32_t now = TIM2->CCR2;                    /* reading CCR2 clears the flag */
          if (GPIOB->IDR & (1u << 3)) { rise = now; } else { width = now - rise; captures++; }
        }
      }
      int main(void) {
        RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
        RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;
        GPIOB->MODER |= GPIO_MODER_MODER3_1;
        GPIOB->AFR[0] |= 2u << (3 * 4);                 /* AF2 = TIM2_CH2 */
        TIM2->PSC = 7;                                  /* 1 MHz: 1 tick = 1 us */
        TIM2->CCMR1 = TIM_CCMR1_CC2S_0;                 /* IC2 mapped on TI2 */
        TIM2->CCER = TIM_CCER_CC2E | TIM_CCER_CC2P | TIM_CCER_CC2NP;   /* both edges */
        TIM2->DIER = TIM_DIER_CC2IE;
        NVIC_EnableIRQ(TIM2_IRQn);
        TIM2->EGR = TIM_EGR_UG;
        TIM2->CR1 = TIM_CR1_CEN;
        for (;;) { }
      }`);
    const src = {};
    const echo = mcu.net('PB3');
    echo.drive(src, 0);
    mcu.runSeconds(0.01);
    echo.drive(src, 3.3);
    mcu.runSeconds(0.002436);
    echo.drive(src, 0);
    mcu.runSeconds(0.01);
    expect(mcu.readGlobal('captures')).toBe(1);
    const width = mcu.readGlobal('width')!;
    expect(Math.abs(width - 2436)).toBeLessThanOrEqual(1);
  });
});

describe('EXTI', () => {
  const src = (clear: string) => `
    volatile uint32_t presses;
    void EXTI4_15_IRQHandler(void) {
      ${clear}
      presses++;
    }
    int main(void) {
      RCC->AHBENR |= RCC_AHBENR_GPIOCEN;
      RCC->APB2ENR |= RCC_APB2ENR_SYSCFGCOMPEN;
      SYSCFG->EXTICR[3] |= SYSCFG_EXTICR4_EXTI13_PC;
      EXTI->FTSR |= EXTI_FTSR_TR13;
      EXTI->IMR |= EXTI_IMR_MR13;
      NVIC_EnableIRQ(EXTI4_15_IRQn);
      for (;;) { }
    }`;

  it('counts falling edges on PC13 once each when the pending flag is cleared', async () => {
    const mcu = await boot(src('EXTI->PR = EXTI_PR_PR13;'));
    const btn = {};
    const net = mcu.net('PC13');
    net.drive(btn, null, 3.3);
    mcu.runSeconds(0.001);
    for (let i = 0; i < 3; i++) {
      net.drive(btn, 0, 3.3);
      mcu.runSeconds(0.001);
      net.drive(btn, null, 3.3);
      mcu.runSeconds(0.001);
    }
    expect(mcu.readGlobal('presses')).toBe(3);
    expect(mcu.hints).toEqual([]);
  });

  it('re-enters forever when the pending flag is not cleared', async () => {
    const mcu = await boot(src(''));
    const btn = {};
    const net = mcu.net('PC13');
    net.drive(btn, null, 3.3);
    mcu.runSeconds(0.001);
    net.drive(btn, 0, 3.3);
    mcu.runSeconds(0.02);
    expect(mcu.readGlobal('presses')!).toBeGreaterThan(1000);
    expect(hintIds(mcu)).toContain('storm:23');
  });

  it('needs the SYSCFG clock to route a port other than A', async () => {
    const mcu = await boot(src('EXTI->PR = EXTI_PR_PR13;').replace('RCC->APB2ENR |= RCC_APB2ENR_SYSCFGCOMPEN;', ''));
    mcu.runSeconds(0.001);
    expect(hintIds(mcu)).toContain('noclk:SYSCFG');
  });
});

describe('ADC', () => {
  it('converts the voltage on PA0 and the result is read after EOC', async () => {
    const mcu = await boot(`
      volatile uint32_t sample, done;
      int main(void) {
        RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
        RCC->APB2ENR |= RCC_APB2ENR_ADCEN;
        GPIOA->MODER |= GPIO_MODER_MODER0;              /* analog */
        ADC1->CR |= ADC_CR_ADCAL;
        while (ADC1->CR & ADC_CR_ADCAL) { }
        ADC1->CR |= ADC_CR_ADEN;
        while (!(ADC1->ISR & ADC_ISR_ADRDY)) { }
        ADC1->CHSELR = ADC_CHSELR_CHSEL0;
        for (;;) {
          ADC1->CR |= ADC_CR_ADSTART;
          while (!(ADC1->ISR & ADC_ISR_EOC)) { }
          sample = ADC1->DR;
          done++;
        }
      }`);
    const pot = {};
    mcu.net('PA0').drive(pot, 1.65);
    mcu.runSeconds(0.005);
    expect(mcu.readGlobal('done')!).toBeGreaterThan(10);
    expect(mcu.readGlobal('sample')).toBe(2048);
    mcu.net('PA0').drive(pot, 3.3);
    mcu.runSeconds(0.001);
    expect(mcu.readGlobal('sample')).toBe(4095);
    expect(mcu.hints).toEqual([]);
  });

  it('refuses ADSTART without ADEN and says so', async () => {
    const mcu = await boot(`
      int main(void) {
        RCC->APB2ENR |= RCC_APB2ENR_ADCEN;
        ADC1->CHSELR = ADC_CHSELR_CHSEL0;
        ADC1->CR |= ADC_CR_ADSTART;
        for (;;) { }
      }`);
    mcu.runSeconds(0.001);
    expect(hintIds(mcu)).toContain('adc:start');
  });
});

describe('USART2 and printf', () => {
  it('sends printf output at 115200 baud with correct bit timing on PA2', async () => {
    const mcu = await boot(`
      int main(void) {
        printf("Hi %d\\n", 42);
        for (;;) { }
      }`);
    const bytes: number[] = [];
    let baud = 0;
    mcu.usart2.onTx = (b, bd) => {
      bytes.push(b);
      baud = bd;
    };
    const tx = mcu.net('PA2');
    tx.startTrace();
    mcu.runSeconds(0.01);
    expect(String.fromCharCode(...bytes)).toBe('Hi 42\n');
    expect(Math.abs(baud - 115200) / 115200).toBeLessThan(0.01);
    // 'H' = 0x48 = 0b01001000, LSB first after the start bit: the first low phase lasts 4 bit times
    const f = falls(tx);
    const r = rises(tx).filter((t) => t > f[0]);
    expect(r[0] - f[0]).toBeCloseTo(4 / baud, 7);
    expect(mcu.hints).toEqual([]);
  });

  it('receives bytes through the RXNE interrupt and reports overrun when they are not read', async () => {
    const mcu = await boot(`
      volatile uint32_t count; volatile char last;
      void USART2_IRQHandler(void) {
        if (USART2->ISR & USART_ISR_RXNE) { last = (char)USART2->RDR; count++; }
      }
      int main(void) {
        RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
        RCC->APB1ENR |= RCC_APB1ENR_USART2EN;
        GPIOA->MODER |= GPIO_MODER_MODER2_1 | GPIO_MODER_MODER3_1;
        GPIOA->AFR[0] |= (1u << 8) | (1u << 12);
        USART2->BRR = 8000000u / 115200u;
        USART2->CR1 = USART_CR1_TE | USART_CR1_RE | USART_CR1_RXNEIE | USART_CR1_UE;
        NVIC_EnableIRQ(USART2_IRQn);
        for (;;) { }
      }`);
    mcu.runSeconds(0.001);
    for (const ch of 'abc') mcu.usart2.receive(ch.charCodeAt(0), 115200);
    mcu.runSeconds(0.002);
    expect(mcu.readGlobal('count')).toBe(3);
    expect(mcu.readGlobal('last', 1)).toBe('c'.charCodeAt(0));
    expect(mcu.hints).toEqual([]);
  });
});

describe('watchdog, reset and faults', () => {
  it('resets the chip when the watchdog is not kicked, and the cause is visible in RCC_CSR', async () => {
    const mcu = await boot(`
      volatile uint32_t was_watchdog;
      int main(void) {
        was_watchdog = (RCC->CSR & RCC_CSR_IWDGRSTF) ? 1u : 0u;
        IWDG->KR = 0xCCCC;
        IWDG->KR = 0x5555;
        IWDG->PR = 0;                                   /* /4: 10 kHz */
        IWDG->RLR = 499;                                /* 50 ms */
        IWDG->KR = 0xAAAA;                              /* load the new reload value */
        for (;;) { }
      }`);
    mcu.runSeconds(0.04);
    expect(mcu.resetCount).toBe(1);
    expect(mcu.readGlobal('was_watchdog')).toBe(0);
    mcu.runSeconds(0.03);
    expect(mcu.resetCount).toBe(2);
    expect(mcu.lastResetCause).toBe('iwdg');
    expect(mcu.readGlobal('was_watchdog')).toBe(1);
  });

  it('keeps running when the watchdog is kicked in time', async () => {
    const mcu = await boot(`${SYSTICK_DELAY}
      int main(void) {
        SysTick_Config(SystemCoreClock / 1000);
        IWDG->KR = 0xCCCC;
        IWDG->KR = 0x5555;
        IWDG->PR = 0;
        IWDG->RLR = 499;
        IWDG->KR = 0xAAAA;
        for (;;) { delay_ms(20); IWDG->KR = 0xAAAA; }
      }`);
    mcu.runSeconds(0.5);
    expect(mcu.resetCount).toBe(1);
  });

  it('raises a HardFault with an explanation for a wild pointer write', async () => {
    const mcu = await boot(`
      int main(void) {
        volatile uint32_t *p = (uint32_t *)0x30000000u;
        *p = 1;
        for (;;) { }
      }`);
    let fault: string | null = null;
    mcu.onFault = (f) => {
      fault = f.message;
      mcu.cpu.stopRequested = true;
    };
    mcu.runSeconds(0.01);
    expect(fault).toMatch(/0x30000000/);
    expect(mcu.functionAt(mcu.cpu.lastFault!.pc)).toBe('main');
    expect(mcu.cpu.ipsr).toBe(3);
  });

  it('faults on an unaligned 32-bit access like a real Cortex-M0', async () => {
    const mcu = await boot(`
      uint8_t buffer[16];
      int main(void) {
        uint8_t *volatile raw = &buffer[1];             /* volatile: the compiler cannot see the misalignment */
        uint32_t *p = (uint32_t *)(void *)raw;
        *p = 0x12345678u;
        for (;;) { }
      }`);
    mcu.onFault = () => {
      mcu.cpu.stopRequested = true;
    };
    mcu.runSeconds(0.01);
    expect(mcu.cpu.lastFault?.kind).toBe('unaligned');
  });

  it('stops with "exit" when main returns', async () => {
    const mcu = await boot(`int main(void) { return 0; }`);
    mcu.runSeconds(0.01);
    expect(mcu.cpu.halted).toBe('exit');
  });

  it('performs a software reset through NVIC_SystemReset', async () => {
    const mcu = await boot(`
      int main(void) {
        if (!(RCC->CSR & RCC_CSR_SFTRSTF)) { NVIC_SystemReset(); }
        for (;;) { }
      }`);
    mcu.runSeconds(0.01);
    expect(mcu.resetCount).toBe(2);
    expect(mcu.lastResetCause).toBe('software');
  });
});
