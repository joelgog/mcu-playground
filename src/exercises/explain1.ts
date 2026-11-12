/**
 * Explained model solutions, exercises 1-10.
 *
 * Every `code` passage is copied from the reference solution; tests/walkthroughs.test.ts
 * fails if a passage no longer appears there, so the explanation cannot drift away
 * from the code that is actually tested.
 */
import type { Walkthrough } from './types';

const c = String.raw;

export const EXPLAIN_1: Record<string, Walkthrough> = {
  'hello-gpio': {
    idea:
      "A pin does nothing until three things have happened, always in this order: its port gets a clock, the pin is made an output, and the output bit is written. " +
      "The loop then flips that bit every half second.",
    steps: [
      {
        title: "Give port A a clock",
        why:
          "After reset almost every peripheral is switched off to save power. A peripheral without a clock ignores every write, " +
          "so this line has to come before anything else that touches `GPIOA`.",
        code: c`RCC->AHBENR |= RCC_AHBENR_GPIOAEN;`,
        how:
          "`RCC` is the reset and clock control block. `AHBENR` is its enable register for everything on the AHB bus, which is where the GPIO ports sit. " +
          "`RCC_AHBENR_GPIOAEN` is the enable bit of port A (bit 17). `|=` sets that one bit and leaves the other enable bits as they are.",
        refs: ['RCC.AHBENR'],
      },
      {
        title: "Make PA5 an output",
        why:
          "Every pin starts as an input. `MODER` holds two bits per pin, and the value `01` means general-purpose output. Pin 5 owns bits 11 and 10.",
        code: c`GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;`,
        how:
          "Read the register, clear both bits of pin 5 (`& ~GPIO_MODER_MODER5`), set the lower one (`| GPIO_MODER_MODER5_0`) and write the result back. " +
          "Clearing first gives `01` whatever was in the field before.\n\n" +
          "All other pins keep their setting. That matters for PA13 and PA14: they carry the debugger connection, and overwriting the whole register would cut it.",
        refs: ['GPIO.MODER'],
      },
      {
        title: "Toggle the pin, then wait",
        why: "The LED is lit while PA5 is high. Flipping the output bit every 500 ms gives 500 ms on and 500 ms off, which is one blink per second.",
        code: c`for (;;) {
    GPIOA->ODR ^= 1u << 5;
    delay_ms(500);
}`,
        how:
          "`ODR` is the output data register: bit 5 is the level of PA5. `^=` is exclusive-or, which inverts exactly the bits that are 1 in the mask. " +
          "`1u << 5` is a mask with only bit 5 set; the `u` makes it unsigned, the safe type for bit work.\n\n" +
          "`delay_ms()` is provided and blocks for the given time. `for (;;)` never ends, because firmware has nowhere to return to.",
        refs: ['GPIO.ODR'],
      },
    ],
    mistakes: [
      { mistake: "Leaving out the clock enable", result: "It compiles and runs, and the LED stays dark. The simulator reports it under Hints; real hardware says nothing." },
      {
        mistake: "`GPIOA->MODER = GPIO_MODER_MODER5_0;`",
        result: "The LED works, but every other pin of port A is reconfigured, including the debug pins PA13 and PA14. On a real board the debugger loses its connection.",
      },
      { mistake: "`delay_ms(1000)` for a 1 Hz blink", result: "The LED blinks at 0.5 Hz: one blink is two toggles." },
    ],
    say:
      "Peripherals are clock-gated, so I first enable GPIOA in the RCC AHB enable register. Then I set the two mode bits of pin 5 to output with a read-modify-write, " +
      "so the other pins, especially the debug pins, keep their configuration. In the loop I toggle bit 5 of the output data register and wait 500 ms. " +
      "In a product I would use a timer instead of a blocking delay.",
  },

  'bit-masks': {
    idea:
      "Give every pin a named mask once, then the loop reads like the task description. The button is tested with AND, " +
      "and each port gets one write to `BSRR` that switches some LEDs on and the others off in the same instant.",
    steps: [
      {
        title: "Name the pins",
        why: "A mask is a number with a 1 at the position of the pin. Named masks keep bare numbers out of the logic and make a wrong pin easy to spot.",
        code: c`#define LED_BOARD  (1u << 5)    /* PA5  */
#define LED_RED    (1u << 8)    /* PC8  */
#define LED_YELLOW (1u << 9)    /* PC9  */
#define LED_GREEN  (1u << 10)   /* PC10 */
#define LED_BLUE   (1u << 11)   /* PC11 */
#define BUTTON     (1u << 13)   /* PC13 */`,
        how: "`1u << 8` is bit 8, so `LED_RED` stands for PC8. Masks of the same port combine with `|`: `LED_RED | LED_GREEN` means both pins.",
      },
      {
        title: "Clock both ports",
        why: "The LEDs and the button are on ports A and C. Each port has its own enable bit.",
        code: c`RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOCEN;`,
        how: "Two enable bits are OR-ed together and set with a single `|=`.",
        refs: ['RCC.AHBENR'],
      },
      {
        title: "Make the five LED pins outputs",
        why:
          "PC13 stays an input, which is the reset state, so only the LED pins change. PC8 to PC11 are neighbours, " +
          "so their four mode fields form one block of 8 bits.",
        code: c`GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
/* PC8..PC11: four 2-bit fields starting at bit 16, each set to 01 */
GPIOC->MODER = (GPIOC->MODER & ~(0xFFu << 16)) | (0x55u << 16);`,
        how:
          "Pin n uses bits 2n+1 and 2n, so pin 8 starts at bit 16. `0xFFu << 16` covers the 8 bits of pins 8 to 11 and is cleared first. " +
          "0x55 is binary 01 01 01 01: output mode, four times.",
        refs: ['GPIO.MODER'],
      },
      {
        title: "Read the button",
        why: "The button connects PC13 to ground when pressed, so pressed reads as 0. This is called active low and is the usual way to wire a button.",
        code: c`if ((GPIOC->IDR & BUTTON) == 0u) {`,
        how:
          "`IDR` is the input data register with the current level of all 16 pins. AND with the mask keeps only bit 13. " +
          "The result is 0 when the pin is low, which means pressed. Never compare with 1: a set bit 13 has the value 0x2000.",
        refs: ['GPIO.IDR'],
      },
      {
        title: "Write each pattern with BSRR",
        why:
          "`BSRR` is a write-only register made for this. A 1 in bits 0 to 15 sets that pin, a 1 in bits 16 to 31 resets pin n-16, and zeros do nothing. " +
          "One write therefore switches some pins on and others off at the same moment, without reading the port first.",
        code: c`if ((GPIOC->IDR & BUTTON) == 0u) {
    GPIOA->BSRR = LED_BOARD;
    GPIOC->BSRR = LED_RED | LED_GREEN | ((LED_YELLOW | LED_BLUE) << 16);
} else {
    GPIOA->BSRR = LED_BOARD << 16;
    GPIOC->BSRR = LED_YELLOW | LED_BLUE | ((LED_RED | LED_GREEN) << 16);
}`,
        how:
          "Pressed: set PA5, set red and green, and reset yellow and blue by shifting their masks into the upper half. Released: the mirror image.\n\n" +
          "Use `=` here, never `|=`. The register is write-only, so there is nothing meaningful to read back.",
        refs: ['GPIO.BSRR'],
      },
    ],
    mistakes: [
      {
        mistake: "`if (GPIOC->IDR & BUTTON == 0u)`",
        result: "`==` binds tighter than `&`, so this evaluates `BUTTON == 0u` first and the condition is always false. Put the AND in parentheses.",
      },
      { mistake: "`GPIOC->ODR = LED_RED | LED_GREEN;`", result: "It works here, but overwrites every other output of port C. With `BSRR` only the named pins change." },
      { mistake: "Treating the button as active high", result: "The pattern is inverted: the pressed pattern shows while the button is released." },
    ],
    say:
      "I define a mask per pin, enable both port clocks and set the mode fields with clear-then-set. The button is active low, so I test the input register against the mask and compare with zero. " +
      "For the outputs I use BSRR: the lower half sets pins and the upper half resets them, so one atomic write produces the whole pattern and an interrupt cannot corrupt it.",
  },

  systick: {
    idea:
      "Let an interrupt count milliseconds, and let the main loop look at that counter instead of waiting. " +
      "Each LED remembers when it last toggled, and on every pass the loop asks whether enough time has gone by.",
    steps: [
      {
        title: "Count milliseconds in the SysTick handler",
        why: "The time base must keep running whatever the main loop does, so it belongs in an interrupt. The handler does the least possible: add one.",
        code: c`static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}`,
        how:
          "The name `SysTick_Handler` is fixed: the start-up file puts a function of that name into the vector table, and the CPU calls it on every SysTick interrupt.\n\n" +
          "`volatile` tells the compiler that the variable changes outside the normal program flow, so main must read it from memory each time. " +
          "Unlike most interrupts, SysTick needs no flag cleared in the handler.",
        refs: ['SysTick.CTRL'],
      },
      {
        title: "Set up the two LED pins",
        why: "The same recipe as in Hello GPIO, for PA5 and PC8: clock first, then the mode field.",
        code: c`RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOCEN;
GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
GPIOC->MODER = (GPIOC->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;`,
        how: "Both clocks in one write, then output mode (`01`) for each pin with clear-then-set.",
        refs: ['RCC.AHBENR', 'GPIO.MODER'],
      },
      {
        title: "Start SysTick at 1 kHz",
        why:
          "SysTick counts down from a reload value at the CPU clock and interrupts when it reaches zero. " +
          "With 8,000,000 clock cycles per second, counting 8000 cycles per interrupt gives 1000 interrupts per second.",
        code: c`SysTick_Config(SystemCoreClock / 1000u);`,
        how:
          "`SysTick_Config()` is a CMSIS helper. It writes the reload value minus one to `LOAD`, clears the counter and sets the enable, interrupt and clock-source bits in `CTRL`. " +
          "`SystemCoreClock` is 8000000 after reset; deriving the value from it keeps the code right if the clock changes.",
        refs: ['SysTick_Config', 'SysTick.LOAD'],
      },
      {
        title: "Check elapsed time without blocking",
        why: "`delay_ms()` would stall one LED while waiting for the other. Here nothing waits: the loop spins freely and each task checks whether it is due.",
        code: c`uint32_t now = ms_ticks;

if (now - last_board >= 250u) {
    last_board += 250u;
    GPIOA->ODR ^= 1u << 5;
}
if (now - last_red >= 400u) {
    last_red += 400u;
    GPIOC->ODR ^= 1u << 8;
}`,
        how:
          "`now` is read once per pass, so both tests see the same time.\n\n" +
          "`now - last >= interval` is unsigned arithmetic and stays correct when the counter wraps from 0xFFFFFFFF to 0 after about 49 days. `now >= last + interval` would fail there.\n\n" +
          "`last += interval` moves the deadline by exactly one interval, so a pass that comes late does not shift all later toggles. With `last = now` the lateness would add up.",
        refs: ['GPIO.ODR'],
      },
    ],
    mistakes: [
      {
        mistake: "`ms_ticks` without `volatile`",
        result: "With optimisation the compiler may read it once and keep the value in a register: both LEDs freeze. It works at `-O0`, which makes the bug hard to find.",
      },
      { mistake: "Using `delay_ms()` for one of the LEDs", result: "The other LED can only change between delays, so its timing is wrong." },
      { mistake: "`if (now >= last + 250u)`", result: "Correct for 49 days, then the addition overflows and the comparison goes wrong." },
      { mistake: "Misspelling the handler, for example `Systick_Handler`", result: "Your function is never called. The default handler runs instead, which is an endless loop, and the program hangs at the first tick." },
    ],
    say:
      "SysTick gives me a 1 ms tick in a volatile counter. The main loop never blocks: each task keeps a timestamp and compares elapsed time with unsigned subtraction, which is safe across wrap-around. " +
      "The pattern scales to any number of periodic tasks and is what a simple cooperative scheduler does.",
  },

  debounce: {
    idea:
      "Do not react to edges. Sample the pin every millisecond and accept a new level only after it has been the same for 10 samples in a row. " +
      "A press is counted at the moment the accepted level changes from released to pressed.",
    steps: [
      {
        title: "Give the pin a defined level",
        why:
          "The button connects PB8 to ground when pressed. While it is open nothing drives the pin: it floats and reads noise. " +
          "The internal pull-up resistor holds it high until the button pulls it low.",
        code: c`GPIOB->PUPDR = (GPIOB->PUPDR & ~GPIO_PUPDR_PUPDR8) | GPIO_PUPDR_PUPDR8_0;   /* pull-up */`,
        how: "`PUPDR` has two bits per pin, like `MODER`: `00` none, `01` pull-up, `10` pull-down. Clear the field, then set the lower bit.",
        refs: ['GPIO.PUPDR'],
      },
      {
        title: "Sample at a fixed rate",
        why: "Debouncing is about time, so the samples need a known spacing. SysTick at 1 kHz gives one sample per millisecond, and its handler is a convenient place to take it.",
        code: c`SysTick_Config(SystemCoreClock / 1000u);
...
uint8_t raw = (uint8_t)((GPIOB->IDR >> 8) & 1u);`,
        how: "`GPIOB->IDR >> 8` moves bit 8 down to bit 0 and `& 1u` removes the rest, so `raw` is 1 (released) or 0 (pressed).",
        refs: ['SysTick_Config', 'GPIO.IDR'],
      },
      {
        title: "Accept a level only when it is stable",
        why: "Bouncing lasts up to 5 ms. When the raw level has differed from the accepted one for 10 ms without a break, the contacts have settled.",
        code: c`if (raw == stable_level) {
    change_count = 0;
} else if (++change_count >= DEBOUNCE_MS) {
    stable_level = raw;
    change_count = 0;
    if (raw == 0u) {                    /* debounced falling edge = one press */
        press_count++;
        GPIOA->ODR ^= 1u << 5;
    }
}`,
        how:
          "`stable_level` is the debounced state. While the raw sample agrees with it, the counter is held at 0. Every sample that disagrees adds one, " +
          "and a single bounce back resets it. Only 10 disagreeing samples in a row change the state.",
      },
      {
        title: "Count on the transition, not on the level",
        why: "A press is the moment the debounced state goes from released to pressed. Counting while the level is low would count a long hold many times.",
        code: c`if (raw == 0u) {                    /* debounced falling edge = one press */
    press_count++;
    GPIOA->ODR ^= 1u << 5;
}`,
        how:
          "This code sits inside the branch that just changed the state, so it runs once per change. If the new state is 0, the button was just pressed. " +
          "The release is debounced the same way but not counted.",
      },
      {
        title: "Sleep in the main loop",
        why: "All the work happens in the interrupt, so main has nothing to do.",
        code: c`for (;;) {
    __WFI();
}`,
        how: "`__WFI()` stops the CPU until the next interrupt. The checks do not require it, but an empty spinning loop wastes power for nothing.",
        refs: ['__WFI'],
      },
    ],
    mistakes: [
      { mistake: "No pull-up", result: "The count changes without anyone touching the button. The simulator shows a floating-pin hint." },
      { mistake: "Counting while the pin is low", result: "Holding the button counts thousands of presses." },
      { mistake: "A blocking `delay_ms(20)` after the first edge", result: "It passes simple tests, but stalls everything else for 20 ms and still counts a single noise spike as a press." },
      { mistake: "A debounce time shorter than the bounce, for example 2 ms", result: "Some presses are still counted twice." },
    ],
    say:
      "Contacts bounce for a few milliseconds, so I sample the pin from a 1 ms tick and accept a new state only after 10 identical samples. I count on the debounced falling edge, so a long hold counts once. " +
      "The pin needs a pull-up because the switch only connects to ground. An RC filter in hardware could do the same job; in software it costs nothing.",
  },

  exti: {
    idea:
      "A pin edge reaches your handler through four gates in a row: the port selector in SYSCFG, the edge selector and the mask in EXTI, and the interrupt enable in the NVIC. " +
      "Open all four, then make the handler clear the pending flag.",
    steps: [
      {
        title: "Route PC13 to EXTI line 13",
        why:
          "There is one EXTI line per pin number, shared by all ports: line 13 can listen to PA13, PB13 or PC13. " +
          "The selector is in `SYSCFG`, and SYSCFG needs its own clock first.",
        code: c`RCC->APB2ENR |= RCC_APB2ENR_SYSCFGCOMPEN;
SYSCFG->EXTICR[3] = (SYSCFG->EXTICR[3] & ~SYSCFG_EXTICR4_EXTI13) | SYSCFG_EXTICR4_EXTI13_PC;`,
        how:
          "Each `EXTICR` register holds four lines with 4 bits each, so lines 12 to 15 are in the fourth one. C arrays count from 0, which makes it `EXTICR[3]`, " +
          "while the macros keep the manual's name, EXTICR4. The field is cleared and then set to the code for port C.\n\n" +
          "Without the SYSCFG clock the write is ignored and line 13 keeps listening to PA13.",
        refs: ['RCC.APB2ENR', 'SYSCFG.EXTICR'],
      },
      {
        title: "Choose the edge and unmask the line",
        why: "The button pulls the pin low when pressed, so a press is a falling edge. The mask bit decides whether the line may raise an interrupt at all.",
        code: c`EXTI->FTSR |= EXTI_FTSR_TR13;
EXTI->IMR |= EXTI_IMR_MR13;`,
        how: "`FTSR` is the falling trigger selection register, `IMR` the interrupt mask register. A 1 in `IMR` means not masked, that is, enabled.",
        refs: ['EXTI.FTSR', 'EXTI.IMR'],
      },
      {
        title: "Enable the interrupt in the CPU",
        why: "EXTI only raises a request. The NVIC, the interrupt controller inside the Cortex-M core, decides whether the CPU acts on it.",
        code: c`NVIC_EnableIRQ(EXTI4_15_IRQn);`,
        how: "On this chip lines 4 to 15 share one interrupt number and one handler. `NVIC_EnableIRQ()` is a CMSIS function that sets the matching bit in the NVIC enable register.",
        refs: ['NVIC_EnableIRQ'],
      },
      {
        title: "Handler: check, clear, act",
        why:
          "The pending flag stays set until software clears it. If the handler returns with the flag still set, the CPU enters the handler again at once, for ever, and main never runs.",
        code: c`void EXTI4_15_IRQHandler(void)
{
    if (EXTI->PR & EXTI_PR_PR13) {
        EXTI->PR = EXTI_PR_PR13;            /* write 1 to clear, only this bit */
        GPIOA->ODR ^= 1u << 5;
    }
}`,
        how:
          "The name `EXTI4_15_IRQHandler` is fixed by the vector table. Because the handler serves lines 4 to 15, it first checks that line 13 is the one pending.\n\n" +
          "`EXTI->PR = EXTI_PR_PR13` clears the flag: this register is cleared by writing a 1. A plain `=` writes 1 to bit 13 only. " +
          "`|=` would read the register first and write a 1 back to every pending line, clearing requests that have not been handled.",
        refs: ['EXTI.PR'],
      },
    ],
    mistakes: [
      { mistake: "Not clearing `EXTI->PR`", result: "An interrupt storm: the handler runs back to back, the LED looks dim and `idle_count` stops." },
      { mistake: "`EXTI->PR |= EXTI_PR_PR13;`", result: "It seems to work with one line. With two lines in use it silently drops the other line's interrupt." },
      { mistake: "Forgetting the SYSCFG clock", result: "The routing write is ignored, line 13 stays connected to PA13, and pressing the button does nothing." },
      { mistake: "Forgetting `NVIC_EnableIRQ()`", result: "The pending bit is set in `EXTI->PR`, but the handler is never called." },
    ],
    say:
      "The path is pin, SYSCFG multiplexer, EXTI edge detector and mask, then the NVIC. I enable the SYSCFG clock, select port C for line 13, choose the falling edge, unmask the line and enable the shared EXTI4_15 interrupt. " +
      "In the handler I check the pending bit and clear it by writing 1 with a plain assignment. A real button would also need debouncing, because every bounce is an edge.",
  },

  'timer-irq': {
    idea:
      "A timer divides the 8 MHz clock twice: the prescaler sets how long one tick is, and the auto-reload value sets how many ticks make one period. " +
      "At the end of each period it raises an update interrupt, and the handler toggles the pin. Two toggles make one cycle, so 1 kHz needs 2000 interrupts per second.",
    steps: [
      {
        title: "Clock the timer",
        why: "TIM3 sits on the APB bus, so its enable bit is in a different register from the GPIO ports.",
        code: c`RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;`,
        how: "`APB1ENR` holds the enable bits of the timers, USART2, I2C1 and SPI2. The reference manual states for each peripheral which enable register it belongs to.",
        refs: ['RCC.APB1ENR'],
      },
      {
        title: "Choose prescaler and period",
        why:
          "Update rate = 8 MHz / ((PSC + 1) x (ARR + 1)). Both registers count from zero, hence the minus one. " +
          "Pick a prescaler that makes one tick a round number: dividing by 8 gives a 1 us tick, and 500 ticks are 500 us.",
        code: c`TIM3->PSC = 8u - 1u;                    /* 8 MHz / 8 = 1 MHz tick */
TIM3->ARR = 500u - 1u;                  /* 500 ticks = 500 us -> 2 kHz */`,
        how: "Writing `8u - 1u` instead of 7 keeps the intent visible, and the compiler does the subtraction. The counter runs 0, 1, ... 499 and starts again: 500 ticks.",
        refs: ['TIM.PSC', 'TIM.ARR'],
      },
      {
        title: "Load the prescaler now",
        why: "`PSC` is buffered: a new value takes effect only at the next update event. Without forcing one, the first period would run with the old prescaler.",
        code: c`TIM3->EGR = TIM_EGR_UG;                 /* load PSC now */
TIM3->SR = 0;                           /* UG set UIF: discard it */`,
        how:
          "Setting `UG` in the event generation register creates an update event by software: the prescaler is loaded and the counter starts at 0. " +
          "The event also sets the update flag `UIF`, so the status register is cleared. Otherwise the interrupt would fire the moment it is enabled.",
        refs: ['TIM.EGR', 'TIM.SR'],
      },
      {
        title: "Enable the interrupt and start the counter",
        why: "As with EXTI there are two switches: one in the peripheral and one in the NVIC. The counter is started last, when everything is ready.",
        code: c`TIM3->DIER = TIM_DIER_UIE;
NVIC_EnableIRQ(TIM3_IRQn);
TIM3->CR1 = TIM_CR1_CEN;`,
        how: "`DIER` is the timer's interrupt enable register and `UIE` enables the update interrupt. `CEN` in `CR1` is the counter enable bit.",
        refs: ['TIM.DIER', 'NVIC_EnableIRQ', 'TIM.CR1'],
      },
      {
        title: "Handler: clear the flag, toggle the pin",
        why: "The same rule as for every interrupt: clear the cause, or the handler runs for ever.",
        code: c`void TIM3_IRQHandler(void)
{
    if (TIM3->SR & TIM_SR_UIF) {
        TIM3->SR = ~TIM_SR_UIF;             /* flags are cleared by writing 0 */
        GPIOC->ODR ^= 1u << 8;
    }
}`,
        how:
          "Timer flags are cleared by writing 0, the opposite of EXTI. `TIM3->SR = ~TIM_SR_UIF` writes 0 to `UIF` and 1 to every other flag, and writing 1 leaves a flag alone.\n\n" +
          "`TIM3->SR &= ~TIM_SR_UIF` looks the same but reads first: a flag that becomes set between the read and the write would be cleared by accident.",
        refs: ['TIM.SR'],
      },
    ],
    mistakes: [
      { mistake: "`TIM3->ARR = 500;`", result: "501 ticks per period: 998 Hz instead of 1000 Hz. The check allows 0.1 %, so it fails." },
      { mistake: "Setting the update rate to 1 kHz", result: "The pin toggles 1000 times per second, which is a 500 Hz square wave." },
      { mistake: "Not clearing `UIF`", result: "An interrupt storm: the handler runs back to back and the frequency is far too high." },
      { mistake: "Toggling in a software delay loop", result: "The frequency depends on the optimisation level and on every other interrupt, so it is neither accurate nor steady." },
    ],
    say:
      "The update rate is the timer clock divided by PSC plus one and ARR plus one. I want a toggle every 500 microseconds, so I prescale to 1 MHz and reload at 499. " +
      "I force an update event to load the prescaler, clear the flag it sets, enable the update interrupt in the timer and in the NVIC, then start the counter. " +
      "In the handler I clear UIF by writing zero to it, with a plain assignment so no other flag is lost.",
  },

  pwm: {
    idea:
      "The timer counts from 0 to ARR over and over. In PWM mode the output is high while the counter is below the compare value and low for the rest of the period. " +
      "ARR sets the frequency, CCR the duty cycle, and the pin has to be handed over to the timer.",
    steps: [
      {
        title: "Clock the port and the timer",
        why: "Two peripherals are involved, and each has its own enable bit in a different register.",
        code: c`RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;`,
        how: "GPIO ports hang on the AHB bus and timers on the APB bus, so the two enable bits are in `AHBENR` and `APB1ENR`.",
        refs: ['RCC.AHBENR', 'RCC.APB1ENR'],
      },
      {
        title: "Hand PA5 to the timer",
        why:
          "As a plain output the pin follows `ODR`. In alternate-function mode a peripheral drives it instead. A 4-bit number per pin selects which one; " +
          "the alternate-function table in the datasheet says that on PA5, number 2 is TIM2 channel 1.",
        code: c`/* PA5: alternate function 2 = TIM2_CH1 */
GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_1;
GPIOA->AFR[0] = (GPIOA->AFR[0] & ~(0xFu << (5 * 4))) | (2u << (5 * 4));`,
        how:
          "Mode `10` is alternate function, so this time the upper bit of the field is set (`GPIO_MODER_MODER5_1`).\n\n" +
          "`AFR[0]` holds pins 0 to 7 with 4 bits each, and `AFR[1]` holds pins 8 to 15. Pin 5 starts at bit 20: clear the field with `0xFu << (5 * 4)`, then write 2.",
        refs: ['GPIO.MODER', 'GPIO.AFR'],
      },
      {
        title: "Set frequency and duty cycle",
        why: "With a 1 MHz tick, 1000 ticks are 1 ms, which is 1 kHz. A quarter of that, 250 ticks, is the high time.",
        code: c`TIM2->PSC = 8u - 1u;                    /* 1 MHz tick */
TIM2->ARR = 1000u - 1u;                 /* 1 kHz period */
TIM2->CCR1 = 250u;                      /* 25 % */`,
        how: "Duty = CCR / (ARR + 1) = 250 / 1000. `CCR1` has no minus one: the output is high while `CNT < CCR1`, which is for counts 0 to 249.",
        refs: ['TIM.PSC', 'TIM.ARR', 'TIM.CCR1'],
      },
      {
        title: "Select PWM mode and enable the output",
        why:
          "A timer channel can do several jobs. The mode bits `OC1M` choose what the comparison does to the output, and 110 is PWM mode 1. The output stage has its own enable bit.",
        code: c`TIM2->CCMR1 = TIM_CCMR1_OC1M_2 | TIM_CCMR1_OC1M_1 | TIM_CCMR1_OC1PE;   /* PWM mode 1, preload */
TIM2->CCER = TIM_CCER_CC1E;`,
        how:
          "`TIM_CCMR1_OC1M_2 | TIM_CCMR1_OC1M_1` is binary 110. `OC1PE` switches on preload for `CCR1`: a new duty value takes effect at the start of the next period, not in the middle of a pulse. " +
          "`CC1E` in `CCER` connects the channel to the pin.",
        refs: ['TIM.CCMR1', 'TIM.CCER'],
      },
      {
        title: "Load the registers and start",
        why: "With preload on, the values written so far are waiting in buffers. An update event moves them into the working registers.",
        code: c`TIM2->EGR = TIM_EGR_UG;                 /* load PSC, ARR and CCR1 */
TIM2->CR1 = TIM_CR1_CEN;`,
        how: "`UG` generates the update event and `CEN` starts the counter. From here on the CPU is not involved, which the empty main loop shows.",
        refs: ['TIM.EGR', 'TIM.CR1'],
      },
    ],
    mistakes: [
      { mistake: "`MODER` left at output (`01`)", result: "The pin follows `ODR` and the LED is simply off. The timer runs, but it is not connected to the pin." },
      { mistake: "Wrong function number, or `AFR[1]`", result: "Another function or another pin is selected. There is no signal on PA5." },
      { mistake: "Forgetting `CC1E`", result: "Everything is configured, but the output stage is off and the pin stays low." },
      { mistake: "`TIM2->CCR1 = 25;`", result: "CCR is in timer ticks, not per cent: the duty cycle is 2.5 %." },
    ],
    say:
      "PWM needs three things to agree. The pin is in alternate-function mode with the function number from the datasheet. The channel is in PWM mode 1, where the output is high while the counter is below CCR. " +
      "And the channel output is enabled in CCER. ARR gives the period and CCR the duty cycle. I enable preload so duty changes are glitch-free, and after that the hardware runs without the CPU.",
  },

  servo: {
    idea:
      "Two halves joined by one line of arithmetic. Input: the ADC turns the pot voltage into a number from 0 to 4095. " +
      "Output: a 50 Hz PWM whose pulse width, 1000 to 2000 us, sets the servo angle. With a 1 MHz timer tick, the compare value is the pulse width in microseconds.",
    steps: [
      {
        title: "Clock everything that is used",
        why: "Two ports, the ADC and the timer. Three different enable registers are involved.",
        code: c`RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOBEN;
RCC->APB2ENR |= RCC_APB2ENR_ADCEN;
RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;`,
        how: "The ADC enable bit is in `APB2ENR`, the timer's in `APB1ENR` and the ports' in `AHBENR`.",
        refs: ['RCC.AHBENR', 'RCC.APB2ENR', 'RCC.APB1ENR'],
      },
      {
        title: "Prepare the ADC",
        why: "The ADC of this chip family has a fixed start-up sequence: analog pin mode, calibrate, enable, wait until ready, select the channel.",
        code: c`/* ADC: PA0 analog, calibrate, enable, channel 0 */
GPIOA->MODER |= GPIO_MODER_MODER0;
ADC1->CR |= ADC_CR_ADCAL;
while (ADC1->CR & ADC_CR_ADCAL) {
}
ADC1->CR |= ADC_CR_ADEN;
while (!(ADC1->ISR & ADC_ISR_ADRDY)) {
}
ADC1->CHSELR = ADC_CHSELR_CHSEL0;`,
        how:
          "Analog mode is `11`, both bits set, so a simple `|=` with the whole field mask is enough. It disconnects the digital input from PA0.\n\n" +
          "`ADCAL` starts the self-calibration, and the hardware clears the bit when it is done, hence the wait loop. `ADEN` switches the ADC on and `ADRDY` reports that it is ready. " +
          "`CHSELR` has one bit per channel: bit 0 selects channel 0, which is PA0.",
        refs: ['GPIO.MODER', 'ADC.CR', 'ADC.ISR', 'ADC.CHSELR'],
      },
      {
        title: "Read one sample",
        why: "A conversion takes time, so it is started and then awaited.",
        code: c`static uint16_t adc_read(void)
{
    ADC1->CR |= ADC_CR_ADSTART;
    while (!(ADC1->ISR & ADC_ISR_EOC)) {
    }
    return (uint16_t)ADC1->DR;              /* reading DR clears EOC */
}`,
        how: "`ADSTART` begins a conversion. `EOC`, end of conversion, is set when the result is in `DR`. Reading `DR` returns the 12-bit result and clears `EOC`, so the next call starts clean.",
        refs: ['ADC.CR', 'ADC.ISR', 'ADC.DR'],
      },
      {
        title: "Hand PB10 to TIM2 channel 3",
        why: "The servo signal comes from the timer, so the pin goes to alternate-function mode, as in the PWM exercise.",
        code: c`/* PB10: alternate function 2 = TIM2_CH3 (pins 8..15 live in AFR[1]) */
GPIOB->MODER = (GPIOB->MODER & ~GPIO_MODER_MODER10) | GPIO_MODER_MODER10_1;
GPIOB->AFR[1] = (GPIOB->AFR[1] & ~(0xFu << ((10 - 8) * 4))) | (2u << ((10 - 8) * 4));`,
        how: "Pin 10 is in the upper half of the port, so its 4-bit field is in `AFR[1]`, at position (10 - 8) x 4 = 8.",
        refs: ['GPIO.MODER', 'GPIO.AFR'],
      },
      {
        title: "50 Hz PWM with microsecond resolution",
        why: "A servo expects a pulse every 20 ms. With a tick of 1 us the compare register holds the pulse width directly in microseconds, so no conversion is needed later.",
        code: c`TIM2->PSC = 8u - 1u;                    /* 1 MHz: one tick = 1 us */
TIM2->ARR = 20000u - 1u;                /* 20 ms period */
TIM2->CCR3 = 1500u;
TIM2->CCMR2 = TIM_CCMR2_OC3M_2 | TIM_CCMR2_OC3M_1 | TIM_CCMR2_OC3PE;
TIM2->CCER = TIM_CCER_CC3E;
TIM2->EGR = TIM_EGR_UG;
TIM2->CR1 = TIM_CR1_CEN;`,
        how:
          "Period = 20000 ticks = 20 ms. Channels 3 and 4 are configured in `CCMR2`, with the same PWM mode 1 and preload bits as channel 1 has in `CCMR1`. " +
          "The initial 1500 us puts the servo in the middle until the first reading arrives.",
        refs: ['TIM.PSC', 'TIM.ARR', 'TIM.CCMR2', 'TIM.CCER'],
      },
      {
        title: "Map the reading to a pulse width",
        why: "A reading of 0 must give 1000 us and 4095 must give 2000 us: a linear scale with an offset.",
        code: c`uint32_t raw = adc_read();
TIM2->CCR3 = 1000u + (raw * 1000u) / 4095u;`,
        how:
          "Multiply first, divide last. `raw * 1000u / 4095u` keeps the precision, while `raw / 4095u * 1000u` would be 0 for every reading below full scale, because integer division drops the fraction.\n\n" +
          "The largest product is 4,095,000, far below the 32-bit limit. `raw` is declared `uint32_t` so that the multiplication is done in 32 bits.",
        refs: ['TIM.CCR1'],
      },
    ],
    mistakes: [
      { mistake: "`raw / 4095u * 1000u`", result: "The servo sits at 0 degrees and jumps to 180 only at the very end of the pot." },
      { mistake: "Not waiting for `ADRDY`", result: "`ADSTART` is ignored while the ADC is not ready, and `adc_read()` waits for `EOC` for ever." },
      { mistake: "Using `AFR[0]` for PB10", result: "That configures PB2. No pulses reach the servo." },
      { mistake: "PA0 left as a digital input", result: "The reading still works, but the input buffer draws extra current at mid-level voltages. The simulator shows a hint." },
    ],
    say:
      "I bring up the ADC with the sequence from the manual: calibrate, enable, wait for ready, select the channel. For the servo I run TIM2 at 1 MHz with a 20 ms period, so CCR is the pulse width in microseconds. " +
      "The mapping is 1000 plus raw times 1000 over 4095, multiplying before dividing to keep resolution, and I check that the intermediate value fits in 32 bits.",
  },

  thermostat: {
    idea:
      "Work in integers all the way: ADC counts to millivolts to tenths of a degree. Then compare against two thresholds instead of one: " +
      "on at 30.0, off at 28.0, and in between keep whatever the LED was.",
    steps: [
      {
        title: "Set up the ADC on channel 1",
        why: "The same start-up sequence as in the servo exercise, for PA1, plus a longer sampling time.",
        code: c`RCC->APB2ENR |= RCC_APB2ENR_ADCEN;
GPIOA->MODER |= GPIO_MODER_MODER1;      /* PA1 analog */
ADC1->CR |= ADC_CR_ADCAL;
while (ADC1->CR & ADC_CR_ADCAL) {
}
ADC1->CR |= ADC_CR_ADEN;
while (!(ADC1->ISR & ADC_ISR_ADRDY)) {
}
ADC1->CHSELR = ADC_CHSELR_CHSEL1;
ADC1->SMPR = ADC_SMPR_SMP_2 | ADC_SMPR_SMP_1 | ADC_SMPR_SMP_0;   /* longest sampling time */`,
        how:
          "Clock, analog pin mode, calibrate, enable, wait for ready, select channel 1.\n\n" +
          "`SMPR` sets how long the input is connected to the ADC's sampling capacitor before each conversion. A sensor with a high output resistance needs time to charge it; " +
          "too short a time reads low. All three bits set is the longest setting.",
        refs: ['RCC.APB2ENR', 'ADC.CR', 'ADC.ISR', 'ADC.CHSELR', 'ADC.SMPR'],
      },
      {
        title: "Read one sample",
        why: "Start a conversion, wait until it is finished, fetch the result.",
        code: c`static uint16_t adc_read(void)
{
    ADC1->CR |= ADC_CR_ADSTART;
    while (!(ADC1->ISR & ADC_ISR_EOC)) {
    }
    return (uint16_t)ADC1->DR;
}`,
        how: "`ADSTART` begins the conversion, `EOC` reports the end, and reading `DR` returns the value and clears `EOC`.",
        refs: ['ADC.DR'],
      },
      {
        title: "Counts to millivolts",
        why: "4095 counts correspond to the 3.3 V reference, so millivolts = raw x 3300 / 4095.",
        code: c`uint32_t raw = adc_read();
int32_t millivolts = (int32_t)((raw * 3300u) / 4095u);`,
        how: "Multiply first, divide last. The largest product is about 13.5 million, which fits easily in 32 bits. The result is cast to a signed type because the next step can go negative.",
      },
      {
        title: "Millivolts to tenths of a degree",
        why:
          "The sensor's datasheet gives 500 mV at 0 C plus 10 mV per degree. 10 mV per degree is 1 mV per tenth of a degree, " +
          "so the temperature in tenths is simply the millivolts above 500.",
        code: c`int32_t tenths = millivolts - 500;  /* 10 mV per degree = 1 mV per tenth */

temperature_x10 = tenths;`,
        how: "At 22.5 C the sensor gives 725 mV and the result is 225. At -5 C it gives 450 mV and the result is -50, which is why the type is signed.",
      },
      {
        title: "Alarm with hysteresis",
        why: "With a single threshold, a reading that hovers around 30.0 would switch the LED on and off with every bit of noise.",
        code: c`if (tenths >= ALARM_ON_X10) {
    GPIOC->BSRR = 1u << 8;
} else if (tenths <= ALARM_OFF_X10) {
    GPIOC->BSRR = 1u << (8 + 16);
}
/* between the thresholds: keep the previous state */`,
        how:
          "At or above 30.0 the LED is set, and at or below 28.0 it is reset. Between the two neither branch runs, so the output keeps its state. " +
          "`BSRR` bit 8 sets PC8 and bit 24 resets it. The thresholds are named constants in tenths, the same unit as the measurement.",
        refs: ['GPIO.BSRR'],
      },
    ],
    mistakes: [
      { mistake: "Using `float`", result: "It works, but on a Cortex-M0 it pulls in software floating point: kilobytes of extra code and much slower. Integer scaling is what is expected." },
      { mistake: "`uint32_t` for the temperature", result: "Below 0 C the value wraps to about 4 billion and the alarm is on in the freezer." },
      { mistake: "`else` in place of `else if`", result: "The LED goes off as soon as the reading drops below 30.0: no hysteresis, and the LED flickers." },
      { mistake: "`raw / 4095u * 3300u`", result: "Integer division makes the result 0 for almost every reading." },
    ],
    say:
      "The Cortex-M0 has no FPU, so I use scaled integers: millivolts, then tenths of a degree, multiplying before dividing and checking the range. The value is signed because temperatures go below zero. " +
      "For the alarm I use two thresholds with a dead band, so noise around the limit cannot make the output chatter. Thermostats and Schmitt triggers use the same idea.",
  },

  'input-capture': {
    idea:
      "Let the timer take the timestamps. TIM2 runs as a free microsecond clock. Channel 2 is set to capture: on each edge of the echo pin the hardware copies the counter into CCR2. " +
      "Falling capture minus rising capture is the pulse width in microseconds, and 58 us are one centimetre.",
    steps: [
      {
        title: "Connect the echo pin to TIM2 channel 2",
        why: "For the timer to see the edges, the pin must be handed to it. The datasheet lists TIM2 channel 2 on PB3 as alternate function 2.",
        code: c`/* PB3: alternate function 2 = TIM2_CH2 */
GPIOB->MODER = (GPIOB->MODER & ~GPIO_MODER_MODER3) | GPIO_MODER_MODER3_1;
GPIOB->AFR[0] = (GPIOB->AFR[0] & ~(0xFu << (3 * 4))) | (2u << (3 * 4));`,
        how: "Alternate-function mode (`10`) in `MODER`, and function 2 in the 4-bit field of pin 3 in `AFR[0]`.",
        refs: ['GPIO.MODER', 'GPIO.AFR'],
      },
      {
        title: "Make channel 2 a capture input on both edges",
        why: "The same channel that can produce PWM can also measure. The `CC2S` bits switch channel 2 from output to input.",
        code: c`TIM2->PSC = 8u - 1u;
TIM2->CCMR1 = TIM_CCMR1_CC2S_0;                                 /* channel 2 = input, mapped to TI2 */
TIM2->CCER = TIM_CCER_CC2E | TIM_CCER_CC2P | TIM_CCER_CC2NP;    /* capture on both edges */
TIM2->EGR = TIM_EGR_UG;
TIM2->CR1 = TIM_CR1_CEN;`,
        how:
          "The prescaler gives a 1 us tick. `CC2S` = 01 makes channel 2 an input connected to its own pin. In `CCER`, `CC2P` and `CC2NP` together select both edges and `CC2E` enables capturing.\n\n" +
          "`ARR` is left at its reset value, the maximum. TIM2 is a 32-bit timer, so the counter runs for over an hour before it wraps.",
        refs: ['TIM.CCMR1', 'TIM.CCER', 'TIM.PSC'],
      },
      {
        title: "A microsecond delay from the same counter",
        why: "The trigger pulse and the pause between measurements need short, known delays. The running counter already is a microsecond clock.",
        code: c`static void wait_us(uint32_t us)
{
    uint32_t start = TIM2->CNT;
    while ((TIM2->CNT - start) < us) {
    }
}`,
        how: "Remember the start value and wait until the difference reaches the wanted time. The unsigned subtraction is correct even if the counter wraps during the wait.",
        refs: ['TIM.CNT'],
      },
      {
        title: "Send the trigger pulse",
        why: "The sensor starts a measurement when it sees a high pulse of at least 10 us. Old capture flags are thrown away first, so only edges from this measurement count.",
        code: c`(void)TIM2->CCR2;                   /* discard any stale capture */
TIM2->SR = 0;

GPIOA->BSRR = 1u << 8;
wait_us(12);
GPIOA->BSRR = 1u << (8 + 16);`,
        how: "Reading `CCR2` clears the capture flag `CC2IF`, and writing 0 to `SR` clears the remaining flags. 12 us leaves a margin over the 10 us minimum.",
        refs: ['TIM.SR', 'GPIO.BSRR'],
      },
      {
        title: "Wait for a capture, with a timeout",
        why: "If the sensor is missing or nothing reflects the sound, the edge never comes. A loop without a timeout would hang the whole firmware.",
        code: c`static int wait_capture(uint32_t *value, uint32_t timeout_us)
{
    uint32_t start = TIM2->CNT;
    while (!(TIM2->SR & TIM_SR_CC2IF)) {
        if ((TIM2->CNT - start) > timeout_us) {
            return 0;
        }
    }
    *value = TIM2->CCR2;                    /* reading CCR2 clears CC2IF */
    return 1;
}`,
        how:
          "The loop polls `CC2IF` and gives up after `timeout_us`. On success it reads `CCR2`: the counter value at the instant of the edge, exact no matter how late the software looks. " +
          "The value comes back through a pointer, and the return value says whether it is valid.",
        refs: ['TIM.SR', 'TIM.CCR1'],
      },
      {
        title: "Compute the distance",
        why: "The echo pulse is 58 us long per centimetre, so the distance is the pulse width divided by 58.",
        code: c`if (wait_capture(&rise, 5000u) && wait_capture(&fall, 40000u)) {
    distance_cm = (fall - rise + 29u) / 58u;    /* rounded */
}

wait_us(60000u);`,
        how:
          "The first capture is the rising edge and the second the falling edge. `&&` skips the second wait if the first one timed out, and the old result is kept.\n\n" +
          "Adding 29, half the divisor, before dividing rounds to the nearest centimetre; plain integer division always rounds down. " +
          "The 60 ms pause gives about 15 measurements per second and lets old echoes die away.",
      },
    ],
    mistakes: [
      { mistake: "Timing the pulse by polling `GPIOB->IDR` in a loop", result: "The accuracy depends on the loop speed and on interrupts; short distances are off by centimetres." },
      { mistake: "No timeout", result: "Unplug the sensor and the whole firmware hangs in the wait loop." },
      { mistake: "Only one edge selected in `CCER`", result: "The second capture never arrives and every measurement times out." },
      { mistake: "A trigger pulse shorter than 10 us", result: "The sensor ignores it. The simulator shows a hint." },
    ],
    say:
      "I use input capture so the hardware timestamps the edges and software jitter does not matter. The timer runs at 1 MHz, the channel captures both edges, " +
      "and the pulse width is the unsigned difference of the two captures, which is safe across counter wrap. Every wait has a timeout, so a missing sensor cannot hang the system.",
  },
};
