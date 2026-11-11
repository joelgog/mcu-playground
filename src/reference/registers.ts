/**
 * Register reference for everything the simulator models.
 *
 * Bit positions, offsets and macro names are checked by tests/reference.test.ts
 * against the official ST header (firmware/cmsis/stm32f072xb.h), so they cannot
 * drift from what the compiler sees. The explanations are written for this
 * project; the authoritative text is the cited chapter of the source document.
 */

export interface Field {
  /** Bit range, "17" or "11:10". */
  bits: string;
  /** Name as printed in the reference manual. */
  name: string;
  /** Macro in the CMSIS header, or null. A lowercase x / y marks a pattern (e.g. GPIO_MODER_MODERy). */
  macro: string | null;
  desc: string;
}

export interface RegisterDoc {
  name: string;
  /** C expression for the offset check: member name inside the peripheral struct. */
  member: string;
  offset: number;
  title: string;
  /** What the register does. */
  what: string;
  /** Why and when you touch it, and the usual mistake. */
  why: string;
  fields: Field[];
}

export interface PeripheralDoc {
  /** Key used in links and by the editor lookup, e.g. "GPIO". */
  id: string;
  title: string;
  /** Instances as written in C, e.g. ["GPIOA", "GPIOB"]. */
  instances: string[];
  /** Struct type in the header (for the offset check). */
  struct: string;
  intro: string;
  /** How to switch the peripheral on. */
  enable: string;
  source: { doc: string; chapter: string };
  registers: RegisterDoc[];
}

const f = (bits: string, name: string, macro: string | null, desc: string): Field => ({ bits, name, macro, desc });

export const PERIPHERALS: PeripheralDoc[] = [
  {
    id: 'RCC',
    title: 'Reset and clock control',
    instances: ['RCC'],
    struct: 'RCC_TypeDef',
    intro:
      'RCC owns the clock tree. It selects the system clock source, divides it for the buses, and holds one enable bit per peripheral. ' +
      'After reset almost every peripheral clock is off to save power, so the first line of nearly every driver is a write to one of the ENR registers. ' +
      'A peripheral without a clock ignores writes and reads back zero, with no error of any kind.',
    enable: 'RCC is always clocked.',
    source: { doc: 'rm', chapter: 'Reset and clock control (RCC)' },
    registers: [
      {
        name: 'CR', member: 'CR', offset: 0x00, title: 'Clock control register',
        what: 'Switches the oscillators and the PLL on and off and reports when each is stable.',
        why: 'Every ON bit has a matching RDY flag. An oscillator needs time to start, so the sequence is always: set ON, wait for RDY, only then switch the system clock to it.',
        fields: [
          f('0', 'HSION', 'RCC_CR_HSION', 'Internal 8 MHz RC oscillator on. Set after reset: the chip boots on HSI.'),
          f('1', 'HSIRDY', 'RCC_CR_HSIRDY', 'HSI is stable (read-only).'),
          f('16', 'HSEON', 'RCC_CR_HSEON', 'External crystal / clock input on.'),
          f('17', 'HSERDY', 'RCC_CR_HSERDY', 'HSE is stable (read-only).'),
          f('24', 'PLLON', 'RCC_CR_PLLON', 'PLL on. Configure the PLL in CFGR before setting this; its settings are locked while it runs.'),
          f('25', 'PLLRDY', 'RCC_CR_PLLRDY', 'PLL is locked (read-only).'),
        ],
      },
      {
        name: 'CFGR', member: 'CFGR', offset: 0x04, title: 'Clock configuration register',
        what: 'Selects the system clock source, the bus prescalers and the PLL source and multiplier.',
        why: 'SW requests a source, SWS shows which one is actually in use: always read SWS back before assuming the switch happened. Above 24 MHz the flash needs a wait state (FLASH->ACR) before you speed up.',
        fields: [
          f('1:0', 'SW', 'RCC_CFGR_SW', 'System clock switch: 00 HSI, 01 HSE, 10 PLL, 11 HSI48.'),
          f('3:2', 'SWS', 'RCC_CFGR_SWS', 'System clock in use (read-only), same coding as SW.'),
          f('7:4', 'HPRE', 'RCC_CFGR_HPRE', 'AHB prescaler: divides SYSCLK to make HCLK, the CPU clock.'),
          f('10:8', 'PPRE', 'RCC_CFGR_PPRE', 'APB prescaler: divides HCLK to make PCLK, the peripheral clock.'),
          f('16:15', 'PLLSRC', 'RCC_CFGR_PLLSRC', 'PLL input: 00 HSI/2, 01 HSI/PREDIV, 10 HSE/PREDIV, 11 HSI48/PREDIV.'),
          f('21:18', 'PLLMUL', 'RCC_CFGR_PLLMUL', 'PLL multiplier: value + 2, so 0000 is x2 and 1110 is x16.'),
        ],
      },
      {
        name: 'AHBENR', member: 'AHBENR', offset: 0x14, title: 'AHB peripheral clock enable register',
        what: 'One clock-enable bit for each peripheral on the AHB bus. On this chip that is mainly the GPIO ports.',
        why: 'The classic first bug: configuring GPIOA without setting its bit here. The writes vanish and the pin never moves. Use |= so you do not switch off clocks that are already on (SRAM and flash interface are enabled by default).',
        fields: [
          f('0', 'DMAEN', 'RCC_AHBENR_DMAEN', 'DMA controller clock.'),
          f('17', 'IOPAEN', 'RCC_AHBENR_GPIOAEN', 'GPIO port A clock. The manual calls the bit IOPAEN; the header also offers the clearer name GPIOAEN.'),
          f('18', 'IOPBEN', 'RCC_AHBENR_GPIOBEN', 'GPIO port B clock.'),
          f('19', 'IOPCEN', 'RCC_AHBENR_GPIOCEN', 'GPIO port C clock.'),
          f('20', 'IOPDEN', 'RCC_AHBENR_GPIODEN', 'GPIO port D clock.'),
          f('22', 'IOPFEN', 'RCC_AHBENR_GPIOFEN', 'GPIO port F clock.'),
        ],
      },
      {
        name: 'APB2ENR', member: 'APB2ENR', offset: 0x18, title: 'APB peripheral clock enable register 2',
        what: 'Clock-enable bits for the second group of APB peripherals.',
        why: 'SYSCFG is the one people forget: without its clock, a write to SYSCFG->EXTICR is ignored and an external interrupt on any port other than A never fires.',
        fields: [
          f('0', 'SYSCFGCOMPEN', 'RCC_APB2ENR_SYSCFGCOMPEN', 'SYSCFG and comparator clock. Needed to route a port to an EXTI line.'),
          f('9', 'ADCEN', 'RCC_APB2ENR_ADCEN', 'ADC interface clock.'),
          f('12', 'SPI1EN', 'RCC_APB2ENR_SPI1EN', 'SPI1 clock.'),
          f('14', 'USART1EN', 'RCC_APB2ENR_USART1EN', 'USART1 clock.'),
        ],
      },
      {
        name: 'APB1ENR', member: 'APB1ENR', offset: 0x1c, title: 'APB peripheral clock enable register 1',
        what: 'Clock-enable bits for the first group of APB peripherals: timers, USART2, I2C, SPI2.',
        why: 'Which ENR register holds a peripheral is not guessable; it follows from the bus the peripheral sits on. The memory map table in the reference manual (and the bit names here) tell you.',
        fields: [
          f('0', 'TIM2EN', 'RCC_APB1ENR_TIM2EN', 'Timer 2 clock.'),
          f('1', 'TIM3EN', 'RCC_APB1ENR_TIM3EN', 'Timer 3 clock.'),
          f('4', 'TIM6EN', 'RCC_APB1ENR_TIM6EN', 'Timer 6 clock.'),
          f('5', 'TIM7EN', 'RCC_APB1ENR_TIM7EN', 'Timer 7 clock.'),
          f('8', 'TIM14EN', 'RCC_APB1ENR_TIM14EN', 'Timer 14 clock.'),
          f('14', 'SPI2EN', 'RCC_APB1ENR_SPI2EN', 'SPI2 clock.'),
          f('17', 'USART2EN', 'RCC_APB1ENR_USART2EN', 'USART2 clock.'),
          f('21', 'I2C1EN', 'RCC_APB1ENR_I2C1EN', 'I2C1 clock.'),
        ],
      },
      {
        name: 'CSR', member: 'CSR', offset: 0x24, title: 'Control / status register',
        what: 'Holds the reset-cause flags and the control bits of the low-speed internal oscillator.',
        why: 'Read it first thing after start-up to learn why the chip reset (power-on, reset pin, software, watchdog), then clear the flags with RMVF. The flags accumulate until cleared, so an old watchdog flag can mislead you.',
        fields: [
          f('0', 'LSION', 'RCC_CSR_LSION', 'Low-speed internal oscillator on (the watchdog switches it on by itself).'),
          f('24', 'RMVF', 'RCC_CSR_RMVF', 'Write 1 to clear all reset flags.'),
          f('26', 'PINRSTF', 'RCC_CSR_PINRSTF', 'Reset pin (NRST) flag.'),
          f('27', 'PORRSTF', 'RCC_CSR_PORRSTF', 'Power-on reset flag.'),
          f('28', 'SFTRSTF', 'RCC_CSR_SFTRSTF', 'Software reset flag (NVIC_SystemReset).'),
          f('29', 'IWDGRSTF', 'RCC_CSR_IWDGRSTF', 'Independent watchdog reset flag.'),
        ],
      },
      {
        name: 'CFGR3', member: 'CFGR3', offset: 0x30, title: 'Clock configuration register 3',
        what: 'Selects the kernel clock of peripherals that can run from something other than PCLK.',
        why: 'I2C1 is clocked from HSI by default, independent of the system clock. The value you put in I2C1->TIMINGR is calculated for whichever source is selected here.',
        fields: [
          f('4', 'I2C1SW', 'RCC_CFGR3_I2C1SW', 'I2C1 clock source: 0 HSI (8 MHz), 1 SYSCLK.'),
        ],
      },
      {
        name: 'CR2', member: 'CR2', offset: 0x34, title: 'Clock control register 2',
        what: 'Controls the two extra internal oscillators: HSI14 for the ADC and HSI48.',
        why: 'HSI48 is the simplest way to 48 MHz without a crystal: set HSI48ON, wait for HSI48RDY, add a flash wait state, then switch SW to 11.',
        fields: [
          f('0', 'HSI14ON', 'RCC_CR2_HSI14ON', 'Dedicated 14 MHz ADC oscillator on (the ADC also requests it automatically).'),
          f('16', 'HSI48ON', 'RCC_CR2_HSI48ON', '48 MHz internal oscillator on.'),
          f('17', 'HSI48RDY', 'RCC_CR2_HSI48RDY', 'HSI48 is stable (read-only).'),
        ],
      },
    ],
  },
  {
    id: 'FLASH',
    title: 'Flash memory interface',
    instances: ['FLASH'],
    struct: 'FLASH_TypeDef',
    intro: 'Controls how the CPU reads program memory, and (not simulated here) erasing and programming flash.',
    enable: 'Always clocked.',
    source: { doc: 'rm', chapter: 'Embedded flash memory' },
    registers: [
      {
        name: 'ACR', member: 'ACR', offset: 0x00, title: 'Flash access control register',
        what: 'Sets the number of wait states for flash reads.',
        why: 'Flash cannot deliver data faster than about 24 MHz. Above that the CPU must wait one cycle per read, or it executes garbage. Set LATENCY before raising the clock, clear it after lowering it.',
        fields: [
          f('0', 'LATENCY', 'FLASH_ACR_LATENCY', '0 = zero wait states (up to 24 MHz), 1 = one wait state (24 to 48 MHz). The manual shows a 3-bit field of which only these two values are valid.'),
          f('4', 'PRFTBE', 'FLASH_ACR_PRFTBE', 'Prefetch buffer enable: hides most of the wait-state cost.'),
        ],
      },
    ],
  },
  {
    id: 'GPIO',
    title: 'General-purpose I/O',
    instances: ['GPIOA', 'GPIOB', 'GPIOC', 'GPIOD', 'GPIOF'],
    struct: 'GPIO_TypeDef',
    intro:
      'Each port has up to 16 pins and the same set of registers. A pin is configured in three steps: its mode (input, output, alternate function, analog), ' +
      'its electrical behaviour (push-pull or open-drain, pull-up or pull-down), and, for alternate-function mode, which peripheral signal it carries. ' +
      'Configuration registers pack one field per pin, so edit them with mask-and-set, never with a plain assignment.',
    enable: 'RCC->AHBENR |= RCC_AHBENR_GPIOAEN; (one bit per port)',
    source: { doc: 'rm', chapter: 'General-purpose I/Os (GPIO)' },
    registers: [
      {
        name: 'MODER', member: 'MODER', offset: 0x00, title: 'Port mode register',
        what: 'Two bits per pin select what the pin is: 00 input, 01 output, 10 alternate function, 11 analog.',
        why: 'Pin y uses bits 2y+1 and 2y, so PA5 is bits 11:10. Clear the field, then set it: GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0. Assigning the whole register would also change PA13 and PA14, the debug pins, and lock you out of the debugger.',
        fields: [
          f('2y+1:2y', 'MODERy', 'GPIO_MODER_MODERy', 'Mode of pin y. The header gives the 2-bit mask (GPIO_MODER_MODER5) and each bit (GPIO_MODER_MODER5_0 = output, GPIO_MODER_MODER5_1 = alternate function).'),
        ],
      },
      {
        name: 'OTYPER', member: 'OTYPER', offset: 0x04, title: 'Port output type register',
        what: 'One bit per pin: 0 push-pull (drives high and low), 1 open-drain (only pulls low).',
        why: 'Open-drain is for lines several devices share, such as I2C: nobody ever drives high, so two devices can never short each other. A pull-up resistor supplies the high level.',
        fields: [f('y', 'OTy', 'GPIO_OTYPER_OT_y', 'Output type of pin y.')],
      },
      {
        name: 'OSPEEDR', member: 'OSPEEDR', offset: 0x08, title: 'Port output speed register',
        what: 'Two bits per pin set how fast the output edges are.',
        why: 'Faster edges are needed for fast signals but radiate more noise and draw more current. Leave it low unless the signal is in the megahertz range. Not modelled by the simulator.',
        fields: [f('2y+1:2y', 'OSPEEDRy', 'GPIO_OSPEEDR_OSPEEDRy', 'x0 low, 01 medium, 11 high speed.')],
      },
      {
        name: 'PUPDR', member: 'PUPDR', offset: 0x0c, title: 'Port pull-up / pull-down register',
        what: 'Two bits per pin connect an internal resistor: 00 none, 01 pull-up, 10 pull-down.',
        why: 'An input with nothing driving it floats: it picks up noise and reads random values. A button that only connects the pin to ground needs a pull-up so the open state reads as a clean 1.',
        fields: [f('2y+1:2y', 'PUPDRy', 'GPIO_PUPDR_PUPDRy', 'Pull resistor of pin y. GPIO_PUPDR_PUPDR8_0 selects the pull-up for PB8.')],
      },
      {
        name: 'IDR', member: 'IDR', offset: 0x10, title: 'Port input data register',
        what: 'Read-only. Bit y is the level currently on pin y, whatever the pin mode (except analog).',
        why: 'This is how you read a button: (GPIOC->IDR & (1u << 13)). It reads the real pin, so on an output it tells you whether the pin actually reached the level you wrote.',
        fields: [f('y', 'IDRy', null, 'Level on pin y.')],
      },
      {
        name: 'ODR', member: 'ODR', offset: 0x14, title: 'Port output data register',
        what: 'Bit y is the level driven on pin y when the pin is an output.',
        why: 'Fine for toggling with ^=, but any |= or &= is a read-modify-write: if an interrupt changes another pin of the port in between, its change is lost. BSRR avoids that.',
        fields: [f('y', 'ODRy', null, 'Output level of pin y.')],
      },
      {
        name: 'BSRR', member: 'BSRR', offset: 0x18, title: 'Port bit set / reset register',
        what: 'Write-only. Writing 1 to bit y sets pin y; writing 1 to bit y+16 resets it. Zeros do nothing.',
        why: 'One write changes exactly the pins you name and nothing else, with no read involved, so it is atomic and interrupt-safe. It can also set some pins and clear others in the same instant.',
        fields: [
          f('15:0', 'BSy', 'GPIO_BSRR_BS_y', 'Set pin y.'),
          f('31:16', 'BRy', 'GPIO_BSRR_BR_y', 'Reset pin y. If both are written, set wins.'),
        ],
      },
      {
        name: 'AFR', member: 'AFR[0]', offset: 0x20, title: 'Alternate function registers (AFRL, AFRH)',
        what: 'Four bits per pin select which peripheral signal an alternate-function pin carries (AF0 to AF7). AFR[0] covers pins 0 to 7, AFR[1] pins 8 to 15.',
        why: 'The number comes from the alternate-function table in the datasheet, not the reference manual: for example PA2 is USART2_TX on AF1, PB10 is TIM2_CH3 on AF2. For pin y >= 8 the field sits at bit (y - 8) * 4 of AFR[1].',
        fields: [f('4y+3:4y', 'AFSELy', null, 'Alternate function number of pin y (within its register).')],
      },
      {
        name: 'BRR', member: 'BRR', offset: 0x28, title: 'Port bit reset register',
        what: 'Write-only. Writing 1 to bit y resets pin y.',
        why: 'Same effect as the upper half of BSRR, with the pin number unshifted.',
        fields: [f('15:0', 'BRy', null, 'Reset pin y.')],
      },
    ],
  },
  {
    id: 'SYSCFG',
    title: 'System configuration controller',
    instances: ['SYSCFG'],
    struct: 'SYSCFG_TypeDef',
    intro: 'A small block of system-level switches. The part you need for interrupts is the multiplexer that decides which port feeds each external interrupt line.',
    enable: 'RCC->APB2ENR |= RCC_APB2ENR_SYSCFGCOMPEN;',
    source: { doc: 'rm', chapter: 'System configuration controller (SYSCFG)' },
    registers: [
      {
        name: 'EXTICR', member: 'EXTICR[0]', offset: 0x08, title: 'External interrupt configuration registers 1 to 4',
        what: 'Four bits per EXTI line choose the port: 0 = A, 1 = B, 2 = C and so on. Line n always belongs to pin number n.',
        why: 'There is one line per pin number, shared by all ports: PA13 and PC13 cannot both be interrupt sources. EXTICR[0] holds lines 0 to 3, EXTICR[3] lines 12 to 15. Port A is the reset value, which is why forgetting this register "works" on port A only.',
        fields: [f('4n+3:4n', 'EXTIn', 'SYSCFG_EXTICR4_EXTI13_PC', 'Port for line n. The header has one macro per combination, e.g. SYSCFG_EXTICR4_EXTI13_PC (register 4, line 13, port C).')],
      },
    ],
  },
  {
    id: 'EXTI',
    title: 'Extended interrupts and events controller',
    instances: ['EXTI'],
    struct: 'EXTI_TypeDef',
    intro: 'Detects edges on pins and turns them into interrupt requests. Lines 0 to 15 are the GPIO pins; the port for each line is chosen in SYSCFG.',
    enable: 'No clock bit of its own. The pin must be an input and its port clock must be on.',
    source: { doc: 'rm', chapter: 'Interrupts and events' },
    registers: [
      {
        name: 'IMR', member: 'IMR', offset: 0x00, title: 'Interrupt mask register',
        what: 'Bit n set means line n may raise an interrupt.',
        why: 'Unmasking here is only half of it: the interrupt must also be enabled in the NVIC (NVIC_EnableIRQ) and a handler must exist.',
        fields: [f('n', 'MRn', 'EXTI_IMR_MR13', 'Unmask line n (macro shown for line 13).')],
      },
      {
        name: 'RTSR', member: 'RTSR', offset: 0x08, title: 'Rising trigger selection register',
        what: 'Bit n set means a rising edge on line n is a trigger.',
        why: 'For an active-low button the rising edge is the release. Set both RTSR and FTSR to see press and release.',
        fields: [f('n', 'TRn', 'EXTI_RTSR_TR13', 'Rising edge on line n.')],
      },
      {
        name: 'FTSR', member: 'FTSR', offset: 0x0c, title: 'Falling trigger selection register',
        what: 'Bit n set means a falling edge on line n is a trigger.',
        why: 'For an active-low button the falling edge is the press.',
        fields: [f('n', 'TRn', 'EXTI_FTSR_TR13', 'Falling edge on line n.')],
      },
      {
        name: 'PR', member: 'PR', offset: 0x14, title: 'Pending register',
        what: 'Bit n is set when the selected edge occurred on line n. Cleared by writing 1 to it.',
        why: 'The handler must clear its bit or it is called again the instant it returns, forever. Write EXTI->PR = EXTI_PR_PR13, not |=: with |= you would write back every other pending bit as 1 and clear interrupts you have not handled.',
        fields: [f('n', 'PRn', 'EXTI_PR_PR13', 'Line n is pending. Write 1 to clear.')],
      },
    ],
  },
  {
    id: 'SysTick',
    title: 'System timer (part of the Cortex-M0 core)',
    instances: ['SysTick'],
    struct: 'SysTick_Type',
    intro:
      'A 24-bit down-counter built into every Cortex-M processor. It reloads itself when it reaches zero and can raise an exception each time, ' +
      'which makes it the standard source of a periodic tick. Because it belongs to the core, not to ST, it is documented by Arm and works the same on every Cortex-M chip.',
    enable: 'Always available. SysTick_Config(ticks) sets it up for a periodic interrupt in one call.',
    source: { doc: 'pm', chapter: 'Core peripherals: SysTick timer (STK)' },
    registers: [
      {
        name: 'CTRL', member: 'CTRL', offset: 0x00, title: 'SysTick control and status register',
        what: 'Starts the counter, enables its exception, selects the clock, and holds the "reached zero" flag.',
        why: 'COUNTFLAG is cleared by reading this register, which makes polling it a convenient delay without an interrupt.',
        fields: [
          f('0', 'ENABLE', 'SysTick_CTRL_ENABLE_Msk', 'Counter enable.'),
          f('1', 'TICKINT', 'SysTick_CTRL_TICKINT_Msk', 'Raise the SysTick exception when the counter reaches zero.'),
          f('2', 'CLKSOURCE', 'SysTick_CTRL_CLKSOURCE_Msk', '1 = processor clock, 0 = processor clock / 8.'),
          f('16', 'COUNTFLAG', 'SysTick_CTRL_COUNTFLAG_Msk', 'Set when the counter reached zero since the last read.'),
        ],
      },
      {
        name: 'LOAD', member: 'LOAD', offset: 0x04, title: 'SysTick reload value register',
        what: 'The value the counter restarts from. The period is LOAD + 1 clock ticks.',
        why: 'For a 1 ms tick at 8 MHz: 8000 - 1. The "minus one" is because zero counts as a step. The counter is only 24 bits wide, so the maximum is 16 777 215.',
        fields: [f('23:0', 'RELOAD', null, 'Reload value.')],
      },
      {
        name: 'VAL', member: 'VAL', offset: 0x08, title: 'SysTick current value register',
        what: 'The current count. Any write clears it to zero and clears COUNTFLAG.',
        why: 'Write it once before enabling so the first period is a full one.',
        fields: [f('23:0', 'CURRENT', null, 'Current counter value.')],
      },
    ],
  },
  {
    id: 'TIM',
    title: 'General-purpose and basic timers',
    instances: ['TIM2', 'TIM3', 'TIM14', 'TIM6', 'TIM7'],
    struct: 'TIM_TypeDef',
    intro:
      'A timer is a counter driven by a divided clock. On its own it produces a periodic update event; with its capture/compare channels it generates PWM, ' +
      'measures pulse widths, or fires at exact moments, all in hardware and without jitter. TIM2 is 32 bits wide with four channels, TIM3 is 16 bits with four, ' +
      'TIM14 has one channel, TIM6 and TIM7 have none.',
    enable: 'RCC->APB1ENR |= RCC_APB1ENR_TIM3EN; (one bit per timer)',
    source: { doc: 'rm', chapter: 'General-purpose timers (TIM2 and TIM3); Basic timers (TIM6 and TIM7); General-purpose timer (TIM14)' },
    registers: [
      {
        name: 'CR1', member: 'CR1', offset: 0x00, title: 'Control register 1',
        what: 'Starts the counter and sets its basic behaviour.',
        why: 'Set CEN last, after everything else is configured, so the first period is already correct.',
        fields: [
          f('0', 'CEN', 'TIM_CR1_CEN', 'Counter enable.'),
          f('1', 'UDIS', 'TIM_CR1_UDIS', 'Update disable: freezes the shadow registers.'),
          f('2', 'URS', 'TIM_CR1_URS', 'Update request source: 1 = only a real overflow sets UIF, not the UG bit.'),
          f('3', 'OPM', 'TIM_CR1_OPM', 'One-pulse mode: the counter stops at the next update event.'),
          f('7', 'ARPE', 'TIM_CR1_ARPE', 'Auto-reload preload: a new ARR value waits for the next update event.'),
        ],
      },
      {
        name: 'SMCR', member: 'SMCR', offset: 0x08, title: 'Slave mode control register',
        what: 'Lets an input edge control the counter (reset, gate, trigger).',
        why: 'Reset mode (SMS = 100) restarts the counter on every input edge, which is how PWM-input measurement works.',
        fields: [
          f('2:0', 'SMS', 'TIM_SMCR_SMS', 'Slave mode: 000 off, 100 reset mode.'),
          f('6:4', 'TS', 'TIM_SMCR_TS', 'Trigger selection: 101 input 1, 110 input 2.'),
        ],
      },
      {
        name: 'DIER', member: 'DIER', offset: 0x0c, title: 'Interrupt enable register',
        what: 'One enable bit per interrupt source of the timer.',
        why: 'The flag in SR is set regardless; DIER decides whether it also requests an interrupt. The interrupt must additionally be enabled in the NVIC.',
        fields: [
          f('0', 'UIE', 'TIM_DIER_UIE', 'Update interrupt enable.'),
          f('1', 'CC1IE', 'TIM_DIER_CC1IE', 'Capture/compare 1 interrupt enable.'),
          f('2', 'CC2IE', 'TIM_DIER_CC2IE', 'Capture/compare 2 interrupt enable.'),
        ],
      },
      {
        name: 'SR', member: 'SR', offset: 0x10, title: 'Status register',
        what: 'Event flags. Each is set by hardware and cleared by writing 0 to it.',
        why: 'Clear a flag with TIM3->SR = ~TIM_SR_UIF. Writing 1 to the other bits leaves them alone, so this cannot lose an event. TIM3->SR &= ~TIM_SR_UIF reads first, and a flag that sets between the read and the write is wiped out.',
        fields: [
          f('0', 'UIF', 'TIM_SR_UIF', 'Update interrupt flag: the counter overflowed (or UG was written).'),
          f('1', 'CC1IF', 'TIM_SR_CC1IF', 'Channel 1: compare match (output) or capture happened (input).'),
          f('2', 'CC2IF', 'TIM_SR_CC2IF', 'Channel 2 flag. Reading CCR2 in capture mode also clears it.'),
          f('9', 'CC1OF', 'TIM_SR_CC1OF', 'Channel 1 overcapture: a second capture arrived before the first was read.'),
        ],
      },
      {
        name: 'EGR', member: 'EGR', offset: 0x14, title: 'Event generation register',
        what: 'Write-only. Lets software trigger a timer event.',
        why: 'PSC is buffered: a new prescaler only takes effect at the next update event. Writing UG forces one immediately. It also sets UIF, so clear SR afterwards if the update interrupt is enabled.',
        fields: [f('0', 'UG', 'TIM_EGR_UG', 'Generate an update event: reload the counter and load PSC, ARR and CCRx from their preload values.')],
      },
      {
        name: 'CCMR1', member: 'CCMR1', offset: 0x18, title: 'Capture/compare mode register 1 (channels 1 and 2)',
        what: 'Decides whether each channel is an output or an input, and how it behaves.',
        why: 'The same bits mean different things in output and input mode, so the manual prints the register twice. For PWM set OCxM = 110 and the preload bit OCxPE, which makes a new duty cycle start cleanly at a period boundary.',
        fields: [
          f('1:0', 'CC1S', 'TIM_CCMR1_CC1S', 'Channel 1 direction: 00 output, 01 input on its own pin, 10 input on the other pin of the pair.'),
          f('3', 'OC1PE', 'TIM_CCMR1_OC1PE', 'Output compare 1 preload enable.'),
          f('6:4', 'OC1M', 'TIM_CCMR1_OC1M', 'Output mode: 011 toggle on match, 110 PWM mode 1 (high while CNT < CCR), 111 PWM mode 2.'),
          f('9:8', 'CC2S', 'TIM_CCMR1_CC2S', 'Channel 2 direction.'),
          f('11', 'OC2PE', 'TIM_CCMR1_OC2PE', 'Output compare 2 preload enable.'),
          f('14:12', 'OC2M', 'TIM_CCMR1_OC2M', 'Channel 2 output mode.'),
        ],
      },
      {
        name: 'CCMR2', member: 'CCMR2', offset: 0x1c, title: 'Capture/compare mode register 2 (channels 3 and 4)',
        what: 'Same as CCMR1, for channels 3 and 4.',
        why: 'Which register a channel lives in is a common slip: channel 3 is the low half of CCMR2, not of CCMR1.',
        fields: [
          f('1:0', 'CC3S', 'TIM_CCMR2_CC3S', 'Channel 3 direction.'),
          f('3', 'OC3PE', 'TIM_CCMR2_OC3PE', 'Output compare 3 preload enable.'),
          f('6:4', 'OC3M', 'TIM_CCMR2_OC3M', 'Channel 3 output mode.'),
          f('14:12', 'OC4M', 'TIM_CCMR2_OC4M', 'Channel 4 output mode.'),
        ],
      },
      {
        name: 'CCER', member: 'CCER', offset: 0x20, title: 'Capture/compare enable register',
        what: 'Connects each channel to its pin and sets its polarity.',
        why: 'A channel configured in CCMR does nothing visible until its CCxE bit is set. For input capture, CCxP and CCxNP together choose the edge: 00 rising, 01 falling, 11 both.',
        fields: [
          f('0', 'CC1E', 'TIM_CCER_CC1E', 'Channel 1 enable.'),
          f('1', 'CC1P', 'TIM_CCER_CC1P', 'Channel 1 polarity (output: active low; input: falling edge).'),
          f('3', 'CC1NP', 'TIM_CCER_CC1NP', 'With CC1P: both edges for input capture.'),
          f('4', 'CC2E', 'TIM_CCER_CC2E', 'Channel 2 enable.'),
          f('8', 'CC3E', 'TIM_CCER_CC3E', 'Channel 3 enable.'),
          f('12', 'CC4E', 'TIM_CCER_CC4E', 'Channel 4 enable.'),
        ],
      },
      {
        name: 'CNT', member: 'CNT', offset: 0x24, title: 'Counter',
        what: 'The current count.',
        why: 'With a 1 MHz tick it is a free-running microsecond clock: elapsed = TIM2->CNT - start works across wrap-around thanks to unsigned arithmetic.',
        fields: [f('31:0', 'CNT', null, 'Counter value (16 bits on TIM3, TIM6, TIM7, TIM14).')],
      },
      {
        name: 'PSC', member: 'PSC', offset: 0x28, title: 'Prescaler',
        what: 'Divides the timer clock: tick frequency = timer clock / (PSC + 1).',
        why: 'The "+ 1" is the classic off-by-one: for a 1 MHz tick from 8 MHz write 7, not 8. The value is buffered and loaded at the next update event (see EGR).',
        fields: [f('15:0', 'PSC', null, 'Prescaler value.')],
      },
      {
        name: 'ARR', member: 'ARR', offset: 0x2c, title: 'Auto-reload register',
        what: 'The counter counts from 0 to ARR, then starts again: period = (ARR + 1) ticks.',
        why: 'Update frequency = timer clock / ((PSC + 1) x (ARR + 1)). Pick PSC for a convenient tick, then ARR for the period.',
        fields: [f('31:0', 'ARR', null, 'Auto-reload value.')],
      },
      {
        name: 'CCR1', member: 'CCR1', offset: 0x34, title: 'Capture/compare registers 1 to 4',
        what: 'Output mode: the compare value. Input mode: the counter value captured at the last edge. CCR2, CCR3 and CCR4 follow at 0x38, 0x3C and 0x40.',
        why: 'In PWM mode 1 the duty cycle is CCR / (ARR + 1). In capture mode the difference between two captures is a time measured by hardware, immune to interrupt latency.',
        fields: [f('31:0', 'CCR', null, 'Compare or capture value.')],
      },
    ],
  },
  {
    id: 'ADC',
    title: 'Analog-to-digital converter',
    instances: ['ADC1'],
    struct: 'ADC_TypeDef',
    intro:
      'Converts a voltage between 0 and 3.3 V into a number from 0 to 4095 (12 bits). There is one converter and a multiplexer in front of it: ' +
      'you select channels, start a conversion and collect the result. Channels 0 to 7 are PA0 to PA7; the pin should be in analog mode.',
    enable: 'RCC->APB2ENR |= RCC_APB2ENR_ADCEN;',
    source: { doc: 'rm', chapter: 'Analog-to-digital converter (ADC)' },
    registers: [
      {
        name: 'ISR', member: 'ISR', offset: 0x00, title: 'Interrupt and status register',
        what: 'Status flags, cleared by writing 1.',
        why: 'Wait for ADRDY after enabling, and for EOC after each start. Reading DR clears EOC for you.',
        fields: [
          f('0', 'ADRDY', 'ADC_ISR_ADRDY', 'ADC is ready to convert.'),
          f('2', 'EOC', 'ADC_ISR_EOC', 'End of conversion: a result is waiting in DR.'),
          f('3', 'EOSEQ', 'ADC_ISR_EOS', 'End of sequence: the last selected channel is done.'),
          f('4', 'OVR', 'ADC_ISR_OVR', 'Overrun: a result was replaced before it was read.'),
        ],
      },
      {
        name: 'CR', member: 'CR', offset: 0x08, title: 'Control register',
        what: 'Calibrates, enables and starts the converter.',
        why: 'The start-up ritual has a fixed order: calibrate with ADCAL while the ADC is disabled and wait until the bit clears; set ADEN and wait for ADRDY; then ADSTART for each conversion. Use |= here: the bits are "set only", writing 0 does nothing.',
        fields: [
          f('0', 'ADEN', 'ADC_CR_ADEN', 'Enable the ADC.'),
          f('1', 'ADDIS', 'ADC_CR_ADDIS', 'Disable the ADC.'),
          f('2', 'ADSTART', 'ADC_CR_ADSTART', 'Start converting the selected channels.'),
          f('4', 'ADSTP', 'ADC_CR_ADSTP', 'Stop an ongoing conversion.'),
          f('31', 'ADCAL', 'ADC_CR_ADCAL', 'Start self-calibration; reads 1 until it finishes.'),
        ],
      },
      {
        name: 'CFGR1', member: 'CFGR1', offset: 0x0c, title: 'Configuration register 1',
        what: 'Resolution, alignment, single or continuous conversion, scan direction.',
        why: 'The reset value (12 bits, right-aligned, single conversion) is what you want most of the time.',
        fields: [
          f('4:3', 'RES', 'ADC_CFGR1_RES', 'Resolution: 00 12 bits, 01 10 bits, 10 8 bits, 11 6 bits.'),
          f('5', 'ALIGN', 'ADC_CFGR1_ALIGN', 'Left-align the result.'),
          f('13', 'CONT', 'ADC_CFGR1_CONT', 'Continuous mode: restart automatically after each sequence.'),
        ],
      },
      {
        name: 'SMPR', member: 'SMPR', offset: 0x14, title: 'Sampling time register',
        what: 'How long the input is connected to the sampling capacitor before the conversion.',
        why: 'A high-impedance source (a voltage divider, some sensors) needs a longer sampling time to charge the capacitor fully; too short and the reading is low and noisy.',
        fields: [f('2:0', 'SMP', 'ADC_SMPR_SMP', '000 = 1.5 ADC clock cycles ... 111 = 239.5 cycles.')],
      },
      {
        name: 'CHSELR', member: 'CHSELR', offset: 0x28, title: 'Channel selection register',
        what: 'One bit per channel. All selected channels are converted in order, lowest first.',
        why: 'Unlike many other ADCs there is no "channel number" field: you set a bit. Channel 16 is the internal temperature sensor, 17 the internal reference.',
        fields: [
          f('0', 'CHSEL0', 'ADC_CHSELR_CHSEL0', 'Channel 0 (PA0).'),
          f('1', 'CHSEL1', 'ADC_CHSELR_CHSEL1', 'Channel 1 (PA1).'),
          f('16', 'CHSEL16', 'ADC_CHSELR_CHSEL16', 'Internal temperature sensor.'),
        ],
      },
      {
        name: 'DR', member: 'DR', offset: 0x40, title: 'Data register',
        what: 'The conversion result.',
        why: 'Voltage = DR x 3.3 V / 4095. Do the maths in integers: millivolts = DR x 3300 / 4095, multiplying first.',
        fields: [f('15:0', 'DATA', null, 'Converted value.')],
      },
    ],
  },
  {
    id: 'USART',
    title: 'Universal synchronous/asynchronous receiver transmitter',
    instances: ['USART2'],
    struct: 'USART_TypeDef',
    intro:
      'The serial port. In asynchronous mode each byte travels as a start bit, eight data bits and a stop bit, at a speed both sides agreed on beforehand. ' +
      'USART2 on PA2 (TX) and PA3 (RX), alternate function 1, is wired to the serial console.',
    enable: 'RCC->APB1ENR |= RCC_APB1ENR_USART2EN; and the two pins in alternate-function mode.',
    source: { doc: 'rm', chapter: 'Universal synchronous/asynchronous receiver transmitter (USART)' },
    registers: [
      {
        name: 'CR1', member: 'CR1', offset: 0x00, title: 'Control register 1',
        what: 'Enables the USART, its transmitter and receiver, and its interrupts.',
        why: 'Enable TXEIE only while you have data to send: TXE is 1 whenever the transmit register is empty, so the interrupt would fire continuously.',
        fields: [
          f('0', 'UE', 'USART_CR1_UE', 'USART enable.'),
          f('2', 'RE', 'USART_CR1_RE', 'Receiver enable.'),
          f('3', 'TE', 'USART_CR1_TE', 'Transmitter enable.'),
          f('5', 'RXNEIE', 'USART_CR1_RXNEIE', 'Interrupt when a byte was received (also fires on overrun).'),
          f('6', 'TCIE', 'USART_CR1_TCIE', 'Interrupt when transmission is complete.'),
          f('7', 'TXEIE', 'USART_CR1_TXEIE', 'Interrupt when the transmit register is empty.'),
        ],
      },
      {
        name: 'BRR', member: 'BRR', offset: 0x0c, title: 'Baud rate register',
        what: 'Divider that sets the bit rate: baud = clock / BRR.',
        why: 'For 115200 baud at 8 MHz: 8000000 / 115200 = 69. The result is 115942 baud, 0.6 % fast, well inside the roughly 2 % a UART tolerates. If you change the system clock, BRR must change with it.',
        fields: [f('15:0', 'BRR', null, 'Clock divider (with 16x oversampling, the default).')],
      },
      {
        name: 'ISR', member: 'ISR', offset: 0x1c, title: 'Interrupt and status register',
        what: 'Status flags of the transmitter and receiver.',
        why: 'TXE means "you may write the next byte", TC means "the last bit has left the pin". Wait for TC, not TXE, before switching off the transmitter or going to sleep.',
        fields: [
          f('1', 'FE', 'USART_ISR_FE', 'Framing error: the stop bit was missing (usually a baud rate mismatch).'),
          f('3', 'ORE', 'USART_ISR_ORE', 'Overrun: a byte arrived before the previous one was read, and was lost.'),
          f('5', 'RXNE', 'USART_ISR_RXNE', 'A received byte is waiting in RDR. Cleared by reading RDR.'),
          f('6', 'TC', 'USART_ISR_TC', 'Transmission complete.'),
          f('7', 'TXE', 'USART_ISR_TXE', 'Transmit data register empty. Cleared by writing TDR.'),
        ],
      },
      {
        name: 'ICR', member: 'ICR', offset: 0x20, title: 'Interrupt flag clear register',
        what: 'Write 1 to clear the corresponding error flag in ISR.',
        why: 'ORE keeps the receive interrupt asserted until it is cleared here. An RX handler that only reads RDR will lock up on the first overrun.',
        fields: [
          f('1', 'FECF', 'USART_ICR_FECF', 'Clear the framing error flag.'),
          f('3', 'ORECF', 'USART_ICR_ORECF', 'Clear the overrun flag.'),
          f('6', 'TCCF', 'USART_ICR_TCCF', 'Clear the transmission complete flag.'),
        ],
      },
      {
        name: 'RDR', member: 'RDR', offset: 0x24, title: 'Receive data register',
        what: 'The byte that was received.',
        why: 'It holds exactly one byte. At 115200 baud the next one arrives 87 microseconds later, which is why reception belongs in an interrupt handler feeding a ring buffer.',
        fields: [f('8:0', 'RDR', null, 'Received data.')],
      },
      {
        name: 'TDR', member: 'TDR', offset: 0x28, title: 'Transmit data register',
        what: 'The byte to send.',
        why: 'Only write it while TXE is 1, otherwise you overwrite a byte that has not been sent yet.',
        fields: [f('8:0', 'TDR', null, 'Data to transmit.')],
      },
    ],
  },
  {
    id: 'IWDG',
    title: 'Independent watchdog',
    instances: ['IWDG'],
    struct: 'IWDG_TypeDef',
    intro:
      'A down-counter on its own 40 kHz oscillator that resets the chip when it reaches zero. Firmware proves it is alive by reloading the counter regularly. ' +
      'Because it has its own clock it keeps working even if the main clock fails, and once started it cannot be stopped by software.',
    enable: 'No clock bit. Started by writing 0xCCCC to IWDG->KR.',
    source: { doc: 'rm', chapter: 'Independent watchdog (IWDG)' },
    registers: [
      {
        name: 'KR', member: 'KR', offset: 0x00, title: 'Key register',
        what: 'Write-only. Three magic values: 0xCCCC start, 0xAAAA reload the counter, 0x5555 unlock PR and RLR.',
        why: 'The keys make it very unlikely that runaway code feeds or reconfigures the watchdog by accident. Reload from one place in the main loop only, never from a timer interrupt.',
        fields: [f('15:0', 'KEY', null, 'Key value.')],
      },
      {
        name: 'PR', member: 'PR', offset: 0x04, title: 'Prescaler register',
        what: 'Divides the 40 kHz clock by 4 x 2^PR.',
        why: 'Write-protected: write 0x5555 to KR first. Timeout = (4 x 2^PR) x (RLR + 1) / 40 kHz.',
        fields: [f('2:0', 'PR', 'IWDG_PR_PR', '000 = /4 ... 110 = /256.')],
      },
      {
        name: 'RLR', member: 'RLR', offset: 0x08, title: 'Reload register',
        what: 'The value the counter restarts from on each 0xAAAA.',
        why: 'The new value is used from the next reload, so write 0xAAAA once after configuring. The reset value 0xFFF with PR = 0 gives about 410 ms.',
        fields: [f('11:0', 'RL', 'IWDG_RLR_RL', 'Reload value.')],
      },
      {
        name: 'SR', member: 'SR', offset: 0x0c, title: 'Status register',
        what: 'Shows that a new prescaler or reload value is still being transferred to the watchdog clock domain.',
        why: 'The watchdog runs on a slow, separate clock, so updates take a few of its cycles. Wait for the register to read zero before relying on new settings.',
        fields: [
          f('0', 'PVU', 'IWDG_SR_PVU', 'Prescaler update in progress.'),
          f('1', 'RVU', 'IWDG_SR_RVU', 'Reload value update in progress.'),
        ],
      },
    ],
  },
  {
    id: 'I2C',
    title: 'Inter-integrated circuit interface',
    instances: ['I2C1'],
    struct: 'I2C_TypeDef',
    intro:
      'A two-wire bus (clock SCL, data SDA) shared by several devices, each with a 7-bit address. Both lines are open-drain with pull-up resistors. ' +
      'On this STM32 generation a whole transfer is described up front in CR2; the hardware then asks for or delivers one byte at a time through flags. ' +
      'I2C1 is on PB6 (SCL) and PB7 (SDA), alternate function 1.',
    enable: 'RCC->APB1ENR |= RCC_APB1ENR_I2C1EN; pins in alternate-function mode and open-drain; then TIMINGR, then PE.',
    source: { doc: 'rm', chapter: 'Inter-integrated circuit (I2C) interface' },
    registers: [
      {
        name: 'CR1', member: 'CR1', offset: 0x00, title: 'Control register 1',
        what: 'Enables the peripheral and its interrupts.',
        why: 'Clearing PE resets the internal state machine, which is the standard way out of a stuck bus state.',
        fields: [
          f('0', 'PE', 'I2C_CR1_PE', 'Peripheral enable.'),
          f('1', 'TXIE', 'I2C_CR1_TXIE', 'Interrupt on TXIS.'),
          f('2', 'RXIE', 'I2C_CR1_RXIE', 'Interrupt on RXNE.'),
          f('4', 'NACKIE', 'I2C_CR1_NACKIE', 'Interrupt on NACKF.'),
          f('5', 'STOPIE', 'I2C_CR1_STOPIE', 'Interrupt on STOPF.'),
          f('6', 'TCIE', 'I2C_CR1_TCIE', 'Interrupt on TC.'),
        ],
      },
      {
        name: 'CR2', member: 'CR2', offset: 0x04, title: 'Control register 2',
        what: 'Describes the next transfer and starts it: device address, direction, number of bytes, and what happens at the end.',
        why: 'The address field holds the 7-bit address shifted left by one (0x48 becomes 0x90 in bits 7:0). With AUTOEND the STOP is sent automatically; without it the transfer pauses at TC so you can issue a repeated START, which is how "write register number, then read" is done.',
        fields: [
          f('9:0', 'SADD', 'I2C_CR2_SADD', 'Slave address. For 7-bit addressing use bits 7:1.'),
          f('10', 'RD_WRN', 'I2C_CR2_RD_WRN', 'Direction: 0 write, 1 read.'),
          f('13', 'START', 'I2C_CR2_START', 'Generate a START (or repeated START) and send the address.'),
          f('14', 'STOP', 'I2C_CR2_STOP', 'Generate a STOP after the current byte.'),
          f('23:16', 'NBYTES', 'I2C_CR2_NBYTES', 'Number of bytes to transfer.'),
          f('24', 'RELOAD', 'I2C_CR2_RELOAD', 'More than 255 bytes: pause at TCR for a new NBYTES.'),
          f('25', 'AUTOEND', 'I2C_CR2_AUTOEND', 'Send STOP automatically after NBYTES.'),
        ],
      },
      {
        name: 'TIMINGR', member: 'TIMINGR', offset: 0x10, title: 'Timing register',
        what: 'Sets the SCL low and high times and the data setup and hold times, in units of the prescaled I2C clock.',
        why: 'The value depends on the I2C clock source and the bus speed. ST publishes tables (and a calculator in STM32CubeMX); 0x10420F13 gives 100 kHz from the 8 MHz HSI. It must be written while PE is 0.',
        fields: [
          f('7:0', 'SCLL', 'I2C_TIMINGR_SCLL', 'SCL low period minus one.'),
          f('15:8', 'SCLH', 'I2C_TIMINGR_SCLH', 'SCL high period minus one.'),
          f('19:16', 'SDADEL', 'I2C_TIMINGR_SDADEL', 'Data hold time.'),
          f('23:20', 'SCLDEL', 'I2C_TIMINGR_SCLDEL', 'Data setup time.'),
          f('31:28', 'PRESC', 'I2C_TIMINGR_PRESC', 'Prescaler minus one.'),
        ],
      },
      {
        name: 'ISR', member: 'ISR', offset: 0x18, title: 'Interrupt and status register',
        what: 'Flags that tell you what the transfer needs next.',
        why: 'A robust wait loop always tests NACKF alongside TXIS or RXNE. If the device does not answer, the data flag never comes and a loop that only waits for it hangs forever.',
        fields: [
          f('1', 'TXIS', 'I2C_ISR_TXIS', 'Transmit: write the next byte to TXDR.'),
          f('2', 'RXNE', 'I2C_ISR_RXNE', 'Receive: a byte is waiting in RXDR.'),
          f('4', 'NACKF', 'I2C_ISR_NACKF', 'The device did not acknowledge (wrong address, busy, or absent).'),
          f('5', 'STOPF', 'I2C_ISR_STOPF', 'A STOP was sent: the transfer is over.'),
          f('6', 'TC', 'I2C_ISR_TC', 'Transfer complete, bus held: issue a START or STOP.'),
          f('15', 'BUSY', 'I2C_ISR_BUSY', 'A transfer is in progress on the bus.'),
        ],
      },
      {
        name: 'ICR', member: 'ICR', offset: 0x1c, title: 'Interrupt clear register',
        what: 'Write 1 to clear the corresponding flag in ISR.',
        why: 'STOPF and NACKF stay set until cleared here. Leave them set and the next transfer appears to finish, or fail, immediately.',
        fields: [
          f('4', 'NACKCF', 'I2C_ICR_NACKCF', 'Clear NACKF.'),
          f('5', 'STOPCF', 'I2C_ICR_STOPCF', 'Clear STOPF.'),
        ],
      },
      {
        name: 'RXDR', member: 'RXDR', offset: 0x24, title: 'Receive data register',
        what: 'The byte that was received. Reading it clears RXNE.',
        why: 'Until you read it the peripheral holds SCL low (clock stretching), so no data is lost, but the bus stands still.',
        fields: [f('7:0', 'RXDATA', null, 'Received byte.')],
      },
      {
        name: 'TXDR', member: 'TXDR', offset: 0x28, title: 'Transmit data register',
        what: 'The byte to send. Writing it clears TXIS.',
        why: 'Write it only in response to TXIS.',
        fields: [f('7:0', 'TXDATA', null, 'Byte to transmit.')],
      },
    ],
  },
  {
    id: 'SPI',
    title: 'Serial peripheral interface',
    instances: ['SPI2'],
    struct: 'SPI_TypeDef',
    intro:
      'A fast, simple bus: a clock, one data line in each direction, and one chip-select line per device. Master and slave are two shift registers joined in a ring, ' +
      'so every byte sent also brings one back. SPI2 is on PB13 (SCK), PB14 (MISO) and PB15 (MOSI), alternate function 0; chip-select lines are ordinary GPIO outputs.',
    enable: 'RCC->APB1ENR |= RCC_APB1ENR_SPI2EN; pins in alternate-function mode; CR2, then CR1, then SPE.',
    source: { doc: 'rm', chapter: 'Serial peripheral interface / inter-IC sound (SPI/I2S)' },
    registers: [
      {
        name: 'CR1', member: 'CR1', offset: 0x00, title: 'Control register 1',
        what: 'Master or slave, clock polarity and phase, speed, bit order, slave-select handling.',
        why: 'CPOL and CPHA together are the "SPI mode" 0 to 3 and must match the device datasheet. In master mode with SSM set you must set SSI too: otherwise the peripheral sees its internal chip-select as low, reports a mode fault and clears MSTR by itself.',
        fields: [
          f('0', 'CPHA', 'SPI_CR1_CPHA', 'Clock phase: 0 sample on the first edge, 1 on the second.'),
          f('1', 'CPOL', 'SPI_CR1_CPOL', 'Clock polarity: idle level of SCK.'),
          f('2', 'MSTR', 'SPI_CR1_MSTR', 'Master mode.'),
          f('5:3', 'BR', 'SPI_CR1_BR', 'Baud rate: PCLK / 2^(BR + 1), so 000 is /2 and 010 is /8.'),
          f('6', 'SPE', 'SPI_CR1_SPE', 'SPI enable. Set it last.'),
          f('7', 'LSBFIRST', 'SPI_CR1_LSBFIRST', 'Send the least significant bit first.'),
          f('8', 'SSI', 'SPI_CR1_SSI', 'Internal slave select level, used when SSM is set.'),
          f('9', 'SSM', 'SPI_CR1_SSM', 'Software slave management: ignore the NSS pin.'),
        ],
      },
      {
        name: 'CR2', member: 'CR2', offset: 0x04, title: 'Control register 2',
        what: 'Frame size, the receive threshold, and interrupt enables.',
        why: 'Two traps of this chip family live here. DS selects the frame size; 0111 is 8 bits. FRXTH must be set for 8-bit frames, or RXNE waits for two bytes and a simple "send one, wait for RXNE" loop hangs.',
        fields: [
          f('6', 'RXNEIE', 'SPI_CR2_RXNEIE', 'Interrupt on RXNE.'),
          f('7', 'TXEIE', 'SPI_CR2_TXEIE', 'Interrupt on TXE.'),
          f('11:8', 'DS', 'SPI_CR2_DS', 'Data size: value + 1 bits, so 0111 is 8 bits and 1111 is 16.'),
          f('12', 'FRXTH', 'SPI_CR2_FRXTH', 'Receive threshold: 1 = RXNE after 8 bits, 0 = after 16 bits.'),
        ],
      },
      {
        name: 'SR', member: 'SR', offset: 0x08, title: 'Status register',
        what: 'Transmit and receive flags and error flags.',
        why: 'Before releasing chip select wait for the byte to be fully shifted out: either wait for RXNE (a byte coming back means the frame is complete) or for BSY to clear.',
        fields: [
          f('0', 'RXNE', 'SPI_SR_RXNE', 'Received data is waiting in DR.'),
          f('1', 'TXE', 'SPI_SR_TXE', 'There is room for more data to send.'),
          f('5', 'MODF', 'SPI_SR_MODF', 'Mode fault: master mode was lost (see SSI).'),
          f('6', 'OVR', 'SPI_SR_OVR', 'Overrun: received data was not read in time.'),
          f('7', 'BSY', 'SPI_SR_BSY', 'A frame is being shifted.'),
        ],
      },
      {
        name: 'DR', member: 'DR', offset: 0x0c, title: 'Data register',
        what: 'Writing queues data to send; reading returns received data. Behind it are small FIFOs.',
        why: 'The width of your access matters. The header declares DR as 16 bits, so SPI2->DR = x queues two bytes. For 8-bit frames go through a byte pointer: *(volatile uint8_t *)&SPI2->DR = x.',
        fields: [f('15:0', 'DR', null, 'Data.')],
      },
    ],
  },
];

/** Core functions and intrinsics used in the exercises (from the CMSIS core header). */
export interface SymbolDoc {
  name: string;
  signature: string;
  desc: string;
  source: { doc: string; chapter: string };
}

export const SYMBOLS: SymbolDoc[] = [
  {
    name: 'NVIC_EnableIRQ', signature: 'void NVIC_EnableIRQ(IRQn_Type irq)',
    desc: 'Enables one interrupt in the processor\'s interrupt controller. A peripheral interrupt needs three things: the enable bit in the peripheral, this call, and a handler with the exact name from the vector table in startup.c.',
    source: { doc: 'pm', chapter: 'Core peripherals: Nested vectored interrupt controller (NVIC)' },
  },
  {
    name: 'NVIC_SetPriority', signature: 'void NVIC_SetPriority(IRQn_Type irq, uint32_t priority)',
    desc: 'Sets an interrupt\'s priority, 0 (highest) to 3 on a Cortex-M0. A handler can only be interrupted by one with a numerically lower priority.',
    source: { doc: 'pm', chapter: 'Core peripherals: Nested vectored interrupt controller (NVIC)' },
  },
  {
    name: 'SysTick_Config', signature: 'uint32_t SysTick_Config(uint32_t ticks)',
    desc: 'Loads SysTick with ticks - 1, selects the processor clock, enables the counter and its exception. SysTick_Config(SystemCoreClock / 1000) gives a 1 ms tick; the handler is SysTick_Handler.',
    source: { doc: 'cmsis', chapter: 'core_cm0.h, SysTick functions' },
  },
  {
    name: '__WFI', signature: 'void __WFI(void)',
    desc: 'Wait for interrupt: stops the CPU clock until an interrupt arrives. Peripherals keep running. The basic building block of low-power firmware.',
    source: { doc: 'pm', chapter: 'Power management' },
  },
  {
    name: '__disable_irq', signature: 'void __disable_irq(void)',
    desc: 'Masks all configurable interrupts (sets PRIMASK). Interrupts that arrive are not lost; they wait until __enable_irq. Use for the shortest possible critical sections.',
    source: { doc: 'pm', chapter: 'Core registers: PRIMASK' },
  },
  {
    name: '__enable_irq', signature: 'void __enable_irq(void)',
    desc: 'Clears PRIMASK. Any interrupt that became pending while masked is taken immediately afterwards.',
    source: { doc: 'pm', chapter: 'Core registers: PRIMASK' },
  },
  {
    name: 'NVIC_SystemReset', signature: 'void NVIC_SystemReset(void)',
    desc: 'Requests a software reset of the whole chip. Afterwards RCC->CSR shows SFTRSTF.',
    source: { doc: 'pm', chapter: 'Core peripherals: System control block (SCB)' },
  },
  {
    name: 'SystemCoreClock', signature: 'uint32_t SystemCoreClock',
    desc: 'CMSIS variable holding the CPU clock in Hz (8000000 after reset). It is only a number in RAM: after changing the clock tree call SystemCoreClockUpdate().',
    source: { doc: 'cmsis', chapter: 'system_stm32f0xx.c' },
  },
];

// ------------------------------------------------------------------ lookup

/** Peripheral class for an instance name: "GPIOA" -> GPIO, "TIM3" -> TIM. */
export function peripheralFor(instance: string): PeripheralDoc | null {
  return PERIPHERALS.find((p) => p.instances.includes(instance) || p.id === instance) ?? null;
}

export function registerDoc(periphId: string, regName: string): { periph: PeripheralDoc; reg: RegisterDoc } | null {
  const periph = PERIPHERALS.find((p) => p.id === periphId);
  if (!periph) return null;
  // CCR2..CCR4 and AFR[1], EXTICR[n] share the entry of their first member
  const base = regName.replace(/\[\d\]$/, '').replace(/^CCR[2-4]$/, 'CCR1');
  const reg = periph.registers.find((r) => r.name === base);
  return reg ? { periph, reg } : null;
}

export interface Lookup {
  periph: PeripheralDoc;
  reg: RegisterDoc;
  field: Field | null;
}

/** Resolve "RCC->AHBENR", "GPIOA->MODER" or a bit macro such as "RCC_AHBENR_GPIOAEN". */
export function lookup(text: string): Lookup | null {
  const arrow = /^([A-Za-z]\w*)->(\w+(?:\[\d\])?)$/.exec(text);
  if (arrow) {
    const periph = peripheralFor(arrow[1]);
    const found = periph && registerDoc(periph.id, arrow[2]);
    return found ? { ...found, field: null } : null;
  }
  // exact macro
  for (const periph of PERIPHERALS) {
    for (const reg of periph.registers) {
      const field = reg.fields.find((x) => x.macro === text);
      if (field) return { periph, reg, field };
    }
  }
  // macro by prefix: PERIPH_REG_...
  let best: Lookup | null = null;
  let bestLen = 0;
  for (const periph of PERIPHERALS) {
    for (const reg of periph.registers) {
      const prefixes = [`${periph.id}_${reg.name}_`, `${periph.id}_${reg.name}`];
      if (periph.id === 'SYSCFG' && reg.name === 'EXTICR') prefixes.push('SYSCFG_EXTICR');
      if (periph.id === 'TIM' && reg.name === 'CCR1') prefixes.push('TIM_CCR');
      for (const prefix of prefixes) {
        if (text.startsWith(prefix) && prefix.length > bestLen) {
          const rest = text.slice(prefix.length).replace(/^_/, '');
          const field =
            reg.fields.find((x) => x.macro && (text === x.macro || text.startsWith(`${x.macro}_`))) ??
            reg.fields.find((x) => x.macro && x.macro.replace(/[xy]$/, '') !== x.macro && text.startsWith(x.macro.replace(/[xy]$/, ''))) ??
            reg.fields.find((x) => rest !== '' && rest.startsWith(x.name.replace(/[xyn]$/, ''))) ??
            null;
          best = { periph, reg, field };
          bestLen = prefix.length;
        }
      }
    }
  }
  return best;
}

/** All concrete bit macros (no pattern placeholders), for completion and for the header check. */
export function concreteMacros(): Array<{ macro: string; periph: PeripheralDoc; reg: RegisterDoc; field: Field }> {
  const out: Array<{ macro: string; periph: PeripheralDoc; reg: RegisterDoc; field: Field }> = [];
  for (const periph of PERIPHERALS) {
    for (const reg of periph.registers) {
      for (const field of reg.fields) {
        if (field.macro && !/[xy]$/.test(field.macro)) out.push({ macro: field.macro, periph, reg, field });
      }
    }
  }
  return out;
}
