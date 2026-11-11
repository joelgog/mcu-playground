/** The "how do I know which register to write" guide, and the reasons behind recurring code patterns. */

export type Block =
  | { type: 'p'; text: string }
  | { type: 'steps'; items: Array<{ title: string; text: string; source?: string }> }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'code'; text: string };

export interface GuideSection {
  id: string;
  title: string;
  blocks: Block[];
}

export const GUIDE: GuideSection[] = [
  {
    id: 'method',
    title: 'How you find out which register to write',
    blocks: [
      {
        type: 'p',
        text:
          'Nobody knows `RCC->AHBENR` by heart at first. It comes out of the documentation by a method that is the same for every microcontroller, ' +
          'and being able to walk through that method is worth more in an interview than any memorised register name. ' +
          'Here it is for the smallest possible task: light the LED on the board.',
      },
      {
        type: 'steps',
        items: [
          {
            title: 'Which pin? Ask the board documentation.',
            text: 'The board user manual (or the schematic) says the user LED is wired to `PA5`: port A, pin 5, lit when the pin is high.',
            source: 'um',
          },
          {
            title: 'What can that pin do? Ask the datasheet.',
            text:
              'The pin table of the datasheet lists every function of PA5. For a plain LED you need it as a general-purpose output, so nothing else is required. ' +
              'If you wanted PWM on it, the alternate-function table would tell you that PA5 is TIM2_CH1 on AF2.',
            source: 'ds',
          },
          {
            title: 'How does the peripheral work? Read its chapter in the reference manual.',
            text:
              'Open the GPIO chapter. Every chapter has the same shape: a functional description first, the registers at the end. ' +
              'The description says a pin is switched to output in the mode register, two bits per pin. The register section shows `GPIOx_MODER` with field `MODER5[1:0]` in bits 11:10, where `01` means output.',
            source: 'rm',
          },
          {
            title: 'Is the peripheral powered? Check the clock tree.',
            text:
              'Peripherals are clocked individually and are off after reset. The memory map table in the reference manual shows which bus GPIOA is on (AHB), ' +
              'and the RCC chapter has the matching register: `RCC_AHBENR`, bit 17, called `IOPAEN`. This step is the one beginners skip, and the symptom is that nothing happens at all.',
            source: 'rm',
          },
          {
            title: 'Translate the manual names into C with the header.',
            text:
              'The CMSIS header turns each peripheral into a struct and each bit into a macro, using fixed rules. Register `RCC_AHBENR` becomes `RCC->AHBENR`; bit `IOPAEN` becomes `RCC_AHBENR_GPIOAEN`; ' +
              'register `GPIOx_MODER` on port A becomes `GPIOA->MODER`; field `MODER5` becomes the mask `GPIO_MODER_MODER5` and its low bit `GPIO_MODER_MODER5_0`.',
            source: 'cmsis',
          },
          {
            title: 'Write it, then verify against the manual.',
            text:
              'Three lines result. Check them the same way you found them: the reset value in the register table tells you what was there before, the pin trace or a debugger tells you what is there now.',
          },
        ],
      },
      {
        type: 'code',
        text:
          'RCC->AHBENR |= RCC_AHBENR_GPIOAEN;                 /* step 4: clock for port A      */\n' +
          'GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5)  /* step 3: clear the 2-bit field */\n' +
          '             | GPIO_MODER_MODER5_0;                 /*         then set it to 01     */\n' +
          'GPIOA->BSRR  = 1u << 5;                             /* drive PA5 high                */',
      },
      {
        type: 'p',
        text:
          'In this playground you can shortcut the search: hover over a register or a bit macro in the editor for a summary and its source, press F1 on it to open the full entry here, ' +
          'or type `RCC->` and pick from the list. On a real project the documents below are open in a PDF reader all day.',
      },
    ],
  },
  {
    id: 'order',
    title: 'Every driver has the same five steps',
    blocks: [
      {
        type: 'p',
        text: 'Whatever the peripheral, initialisation follows one order. When something does not work, walk down the list: the fault is almost always a skipped step, not a wrong value.',
      },
      {
        type: 'table',
        head: ['Step', 'What', 'Where'],
        rows: [
          ['1. Clock', 'Enable the peripheral clock, and the clock of the GPIO port its pins are on.', '`RCC->AHBENR`, `RCC->APB1ENR`, `RCC->APB2ENR`'],
          ['2. Pins', 'Put the pins in the right mode: output, alternate function with the AF number from the datasheet, or analog.', '`GPIOx->MODER`, `AFR`, `OTYPER`, `PUPDR`'],
          ['3. Configure', 'Set up the peripheral while it is still disabled: speed, mode, frame format.', 'the peripheral\'s own registers'],
          ['4. Interrupts', 'If used: enable the source in the peripheral, then the line in the NVIC. Write the handler with the exact name from the vector table.', 'peripheral `DIER` / `CR1` / `IMR`, `NVIC_EnableIRQ()`'],
          ['5. Enable', 'Switch it on last, so it starts in a fully defined state.', '`CEN`, `UE`, `SPE`, `PE`, `ADEN`'],
        ],
      },
    ],
  },
  {
    id: 'reading',
    title: 'How to read a register description',
    blocks: [
      {
        type: 'p',
        text:
          'Each register in the reference manual is drawn as a 32-bit strip with the field names, followed by one paragraph per field. Three things on that page matter beyond the bit positions: ' +
          'the address offset (added to the peripheral base address), the reset value (what the register holds before your code runs), and the access type printed under each bit.',
      },
      {
        type: 'table',
        head: ['Access', 'Meaning', 'What it implies for your code'],
        rows: [
          ['rw', 'Read / write.', 'Normal bit. Use mask-and-set to change it.'],
          ['r', 'Read-only.', 'A status bit set by hardware. Writing has no effect.'],
          ['w', 'Write-only.', 'Reading returns 0. Never use |= on such a register (for example `GPIOx->BSRR`, `IWDG->KR`).'],
          ['rc_w1', 'Read, cleared by writing 1.', 'Flags such as `EXTI->PR`. Assign the bit: `EXTI->PR = EXTI_PR_PR13`. With |= you would clear every pending flag.'],
          ['rc_w0', 'Read, cleared by writing 0.', 'Flags such as `TIMx->SR`. Assign the inverse: `TIM3->SR = ~TIM_SR_UIF`.'],
          ['rs', 'Read, set by writing 1; cleared only by hardware.', 'Command bits such as `ADC_CR` ADSTART or `I2C_CR2` START. Writing 0 does nothing.'],
        ],
      },
      {
        type: 'p',
        text:
          'Reserved bits must be kept at their reset value. That is the real reason for `|=` and `&= ~`: they leave every bit you did not name exactly as it was.',
      },
    ],
  },
  {
    id: 'naming',
    title: 'Naming rules of the CMSIS header',
    blocks: [
      {
        type: 'p',
        text: 'The header is mechanical. Once you know the pattern you can predict almost any name, and the editor completes the rest.',
      },
      {
        type: 'table',
        head: ['In the manual', 'In C', 'Rule'],
        rows: [
          ['RCC_AHBENR', '`RCC->AHBENR`', 'Peripheral, arrow, register. The peripheral name is a pointer to a struct at its base address.'],
          ['GPIOx_MODER (x = A..F)', '`GPIOA->MODER`', 'One struct type, one pointer per instance.'],
          ['bit IOPAEN of RCC_AHBENR', '`RCC_AHBENR_GPIOAEN`', 'PERIPHERAL_REGISTER_FIELD is the mask of the field, already shifted into place.'],
          ['field MODER5[1:0]', '`GPIO_MODER_MODER5`, `_0`, `_1`', 'For multi-bit fields: the whole mask, then each bit numbered from 0.'],
          ['position of a field', '`RCC_AHBENR_GPIOAEN_Pos`', '`_Pos` is the bit number, `_Msk` the mask. `value << X_Pos` builds a field value.'],
          ['interrupt "TIM3 global"', '`TIM3_IRQn`, `TIM3_IRQHandler`', 'The enum value goes to `NVIC_EnableIRQ`; the handler name must match the vector table in startup.c exactly, or the default handler runs instead.'],
        ],
      },
    ],
  },
  {
    id: 'idioms',
    title: 'Why the code looks the way it does',
    blocks: [
      {
        type: 'table',
        head: ['You will see', 'Reason'],
        rows: [
          ['`for (;;) { }`', 'An endless loop: firmware has no operating system to return to, so `main` never ends. It is identical to `while (1)` in the generated code. The `for` form has no condition at all, so compilers and static analysers that warn about "condition is always true" stay quiet. Either is fine; be consistent.'],
          ['`volatile`', 'Tells the compiler the value can change outside the visible program flow: a hardware register, or a variable written in an interrupt handler. Without it the optimiser may read the value once and reuse it, and a wait loop becomes endless. It does not make an access atomic.'],
          ['`1u << 5`, `0xFFu`', 'The `u` makes the constant unsigned. Shifting a signed 1 into bit 31 is undefined behaviour in C, and right-shifting a negative value drags the sign along. Bit work is always done unsigned.'],
          ['`reg |= mask;`  `reg &= ~mask;`', 'Set or clear only the named bits and leave the rest untouched. Registers pack many unrelated fields together; a plain `=` would overwrite all of them.'],
          ['`reg = (reg & ~FIELD) | value;`', 'The safe way to change a multi-bit field: clear the whole field first, then set the new value. Using only `|=` leaves old 1 bits behind.'],
          ['`uint32_t`, `uint8_t`', 'Fixed-width types from `<stdint.h>`. The size of `int` depends on the compiler; a register is exactly 32 bits, a UART byte exactly 8.'],
          ['`static`', 'On a function or global: visible only in this file, which keeps names from colliding and lets the compiler inline or remove what is unused. On a local variable: it keeps its value between calls and lives in RAM, not on the stack.'],
          ['`while (!(REG & FLAG)) { }`', 'Polling: wait for hardware to raise a flag. Simple and fine for short waits, but production code adds a timeout so a missing device cannot hang the system.'],
          ['`(void)x;`', 'Deliberately discards a value or marks a parameter as unused, so the compiler does not warn. Also used to read a register only for its side effect, such as clearing a flag.'],
          ['`*(volatile uint8_t *)&SPI2->DR`', 'Forces an 8-bit access to a register the header declares wider. Needed where the hardware reacts to the access size.'],
        ],
      },
    ],
  },
];
