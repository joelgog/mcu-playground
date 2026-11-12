/** Explained model solutions, exercises 11-19. See explain1.ts for how they are kept in step with the code. */
import type { Walkthrough } from './types';

const c = String.raw;

export const EXPLAIN_2: Record<string, Walkthrough> = {
  'shared-data': {
    idea:
      "Two different bugs with two different fixes. A flag written by an interrupt must be `volatile`, or the optimiser removes the re-read. " +
      "A value made of several words, read while an interrupt can change it, must be read in one piece: here by switching interrupts off for the two loads.",
    steps: [
      {
        title: "Fix 1: make the flag volatile",
        why:
          "In `wait_for_batch()` the compiler sees a loop that reads `data_ready` and never writes it. It concludes that the value cannot change, tests it once and turns the loop into an endless one. " +
          "It has no way of knowing that an interrupt handler runs in between.",
        code: c`static volatile uint8_t data_ready;         /* FIX 1: volatile, it changes behind the compiler's back */`,
        how:
          "`volatile` means that every read and write in the source must really happen, in that order. The loop now loads the flag from memory on each pass and sees the handler's write.\n\n" +
          "At `-O0` the bug does not show, because nothing is optimised. That is why it survives testing and appears in the release build.",
      },
      {
        title: "Fix 2: read the pair inside a critical section",
        why:
          "Copying two words takes two load instructions. If the timer interrupt fires between them, `copy.up` is from before the interrupt and `copy.down` from after it: " +
          "a combination that never existed. `volatile` cannot help, because each single read is fine. The problem is that the two belong together.",
        code: c`/* FIX 2: both fields must come from the same instant -> short critical section */
__disable_irq();
copy.up = shared.up;
copy.down = shared.down;
__enable_irq();`,
        how:
          "`__disable_irq()` sets the CPU's interrupt mask and `__enable_irq()` clears it. An interrupt that arrives in between is not lost: it stays pending and runs right after.\n\n" +
          "The section covers the two loads and nothing else. The comparison and the counters stay outside, because every cycle with interrupts off delays the interrupt.",
        refs: ['__disable_irq', '__enable_irq'],
      },
      {
        title: "Why the handler needs no protection",
        why: "On a single-core microcontroller the main loop cannot interrupt an interrupt handler. From the handler's point of view its two updates happen together.",
        code: c`shared.up++;
shared.down--;`,
        how: "Only the side that can be interrupted has to protect itself, and here that is main. It would be different if a higher-priority interrupt also used the data.",
      },
    ],
    mistakes: [
      { mistake: "Adding `volatile` and stopping there", result: "Bug 1 is fixed, bug 2 stays: `violations` keeps counting." },
      {
        mistake: "Putting all of `take_sample()` or the whole 1000-sample loop in the critical section",
        result: "Interrupts are blocked for long stretches. The 20 kHz interrupt falls behind and the third check fails.",
      },
      {
        mistake: "A `printf` or a delay in the wait loop that makes the hang go away",
        result: "It hides bug 1 by accident, because a function call forces a re-read. The bug returns when the code changes.",
      },
      {
        mistake: "Ending a critical section with `__enable_irq()` in code that can be called with interrupts already off",
        result: "It switches interrupts on behind the caller's back. Library code saves the previous state and restores it instead.",
      },
    ],
    say:
      "volatile tells the compiler a variable can change outside the visible program flow, so every access goes to memory. It does not make anything atomic. " +
      "For data wider than one access, or for an invariant across several variables, I need a critical section, and I keep it as short as possible because it adds interrupt latency. " +
      "On a Cortex-M0 I disable interrupts around the copy; with an RTOS I would use its critical-section call or a mutex.",
  },

  'state-machine': {
    idea:
      "One variable says which phase the light is in. On every pass the loop looks at the current phase and asks one question: is it time to move on? " +
      "Nothing waits, so the heartbeat keeps running alongside.",
    steps: [
      {
        title: "Name the states and the durations",
        why: "An `enum` gives each phase a name the compiler knows, and named constants keep the durations in one place.",
        code: c`#define HEARTBEAT_MS   100u
#define YELLOW_MS     1000u
#define RED_MS        3000u
#define RED_YELLOW_MS 1000u

typedef enum { ST_GREEN, ST_YELLOW, ST_RED, ST_RED_YELLOW } state_t;`,
        how: "Four phases, four names. A reviewer can check the durations against the specification without reading the logic.",
      },
      {
        title: "Remember the state and when it was entered",
        why: "The state machine needs exactly two pieces of memory: where it is, and since when.",
        code: c`state_t state = ST_GREEN;
uint32_t entered = 0;
uint32_t last_beat = 0;`,
        how: "`entered` is the millisecond count at the last transition. `last_beat` does the same job for the heartbeat.",
      },
      {
        title: "Keep the heartbeat going",
        why: "The heartbeat is a second, independent task. Because nothing in the loop blocks, it is checked thousands of times per second.",
        code: c`uint32_t now = ms_ticks;

if (now - last_beat >= HEARTBEAT_MS) {
    last_beat += HEARTBEAT_MS;
    GPIOA->ODR ^= 1u << 5;
}`,
        how: "The non-blocking timing pattern from the SysTick exercise: read the time once, compare elapsed time with unsigned subtraction, move the deadline by one interval.",
      },
      {
        title: "Read the button",
        why: "A small function with a clear name hides the fact that the button is active low.",
        code: c`static int button_pressed(void)
{
    return (GPIOB->IDR & (1u << 8)) == 0u;  /* active low */
}`,
        how: "Mask bit 8 of the input register and compare with zero: the result is 1 while the button is held.",
        refs: ['GPIO.IDR'],
      },
      {
        title: "One case per state",
        why: "A `switch` on the state keeps everything about one phase in one place: when to leave it, and what to do on the way out.",
        code: c`switch (state) {
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
    break;`,
        how:
          "Each case has the same shape: a condition for leaving, and on leaving three actions: set the new state, note the time, set the lights. " +
          "Green leaves on the button, the others on elapsed time. The red and red-yellow cases follow the same pattern.\n\n" +
          "The button is looked at only in `ST_GREEN`, so presses during the sequence are ignored without extra code. " +
          "That also makes debouncing unnecessary: the bounces arrive when the state has already changed.",
      },
    ],
    mistakes: [
      { mistake: "`delay_ms(1000)` between the lights", result: "The sequence looks right, but the heartbeat stops during it and the last check fails." },
      { mistake: "Forgetting `entered = now` in a transition", result: "The next state measures its time from the wrong moment and is left at once or far too late." },
      { mistake: "Forgetting `break`", result: "Execution falls into the next case, and two transitions can happen in one pass." },
      { mistake: "Checking the button in every state", result: "A press during red restarts the sequence." },
    ],
    say:
      "I model it as a state machine: an enum for the states, a timestamp for when the current state was entered, and a switch where each case decides when to leave and sets the outputs on the transition. " +
      "Nothing blocks, so other work such as the heartbeat, communication or a watchdog kick runs in the same loop. Durations are named constants and the comparisons are safe across wrap-around.",
  },

  watchdog: {
    idea:
      "Start a hardware timer that resets the chip unless the main loop reloads it in time, and reload it at exactly one place per pass. " +
      "At start-up, ask the reset-cause register whether the watchdog was the reason.",
    steps: [
      {
        title: "Check why the chip started",
        why: "After a watchdog reset the program starts from the top, exactly as after power-on. Only `RCC->CSR` remembers what caused the reset.",
        code: c`if (RCC->CSR & RCC_CSR_IWDGRSTF) {
    GPIOC->BSRR = 1u << 8;              /* we are here because the watchdog bit */
}
RCC->CSR |= RCC_CSR_RMVF;               /* clear the reset flags for next time */`,
        how:
          "`IWDGRSTF` is set if the independent watchdog caused the last reset. The flags survive resets and add up, so after reading them they are cleared with `RMVF`. " +
          "Otherwise a later normal reset would still show the old watchdog flag.",
        refs: ['RCC.CSR', 'GPIO.BSRR'],
      },
      {
        title: "Start the watchdog with a 200 ms timeout",
        why:
          "The IWDG runs from its own 40 kHz oscillator, so it keeps working even if the main clock fails. " +
          "Its registers are protected by key values, so that runaway code cannot reconfigure it by accident.",
        code: c`static void watchdog_start(void)
{
    IWDG->KR = 0xCCCC;                      /* start (also starts the 40 kHz LSI oscillator) */
    IWDG->KR = 0x5555;                      /* unlock PR and RLR */
    IWDG->PR = 1;                           /* divide by 8: 5 kHz */
    IWDG->RLR = 1000u - 1u;                 /* 1000 ticks = 200 ms */
    while (IWDG->SR != 0u) {                /* wait until the new values are taken over */
    }
    IWDG->KR = 0xAAAA;                      /* reload with the new value */
}`,
        how:
          "0xCCCC starts the watchdog, and from then on it cannot be stopped. 0x5555 unlocks `PR` and `RLR`. `PR` = 1 divides 40 kHz by 8, which gives 0.2 ms per tick. " +
          "`RLR` = 999 gives 1000 ticks, which is 200 ms.\n\n" +
          "`SR` shows that new values are still being transferred to the watchdog's own clock domain, so the code waits until it reads 0. Then 0xAAAA reloads the counter with the new value.",
        refs: ['IWDG.KR', 'IWDG.PR', 'IWDG.RLR', 'IWDG.SR'],
      },
      {
        title: "Kick it once per loop pass",
        why:
          "The kick says that the main loop is still going round. If `process_sensors()` hangs, the loop stops, the kicks stop, and 200 ms later the chip resets.",
        code: c`static void watchdog_kick(void)
{
    IWDG->KR = 0xAAAA;
}
...
watchdog_kick();

process_sensors();`,
        how: "One kick, at one place in the main loop. A normal pass takes microseconds, far inside the 200 ms window.",
        refs: ['IWDG.KR'],
      },
    ],
    mistakes: [
      { mistake: "Kicking from the SysTick handler", result: "The interrupt keeps running while main hangs, so the watchdog never bites. The check 'A hang triggers a watchdog reset' fails." },
      { mistake: "Kicking inside the loop that hangs", result: "The same effect: the watchdog is fed by the very code it should guard against." },
      { mistake: "Not clearing the reset flags", result: "The red LED also lights after a later, normal reset." },
      { mistake: "A timeout shorter than the slowest legitimate loop pass", result: "Random resets in normal operation." },
    ],
    say:
      "The independent watchdog has its own oscillator and resets the chip if the counter is not reloaded in time. I start it with the key sequence, set prescaler and reload for 200 ms, and kick it at one point in the main loop, " +
      "never from an interrupt, so a hung main loop is actually detected. At start-up I read the reset cause from RCC CSR, act on it, and clear the flags.",
  },

  uart: {
    idea:
      "Split receiving into two halves. The interrupt handler takes each byte out of the UART the moment it arrives and puts it into a ring buffer: fast, and never late. " +
      "The main loop takes bytes out of the buffer whenever it has time.",
    steps: [
      {
        title: "Create the ring buffer",
        why:
          "A ring buffer is an array used in a circle, with a write position (head) and a read position (tail). " +
          "During 3 ms of other work about 35 bytes can arrive at 115200 baud, so 128 bytes leave a comfortable margin.",
        code: c`#define RX_SIZE 128u                        /* power of two: wrap with a mask */
#define RX_MASK (RX_SIZE - 1u)

static volatile uint8_t rx_buffer[RX_SIZE];
static volatile uint32_t rx_head;           /* written by the interrupt only */
static volatile uint32_t rx_tail;           /* written by main only */`,
        how:
          "The size is a power of two, so wrapping around is a cheap AND with `RX_MASK` instead of a division. The indices are `volatile` because the handler and main both use them.\n\n" +
          "The rule that makes this safe without disabling interrupts: only the handler writes `rx_head`, and only main writes `rx_tail`.",
      },
      {
        title: "Switch on the receive interrupt",
        why: "The starter only looks at the receiver once per loop pass. With the interrupt on, the hardware calls the handler for every byte.",
        code: c`USART2->CR1 = USART_CR1_TE | USART_CR1_RE | USART_CR1_RXNEIE | USART_CR1_UE;
NVIC_EnableIRQ(USART2_IRQn);`,
        how: "`RXNEIE` makes the UART request an interrupt whenever `RXNE`, receive register not empty, is set. As always, the NVIC needs its own enable.",
        refs: ['USART.CR1', 'NVIC_EnableIRQ'],
      },
      {
        title: "Handler: store the byte",
        why: "The byte has to leave the receive register before the next one arrives 87 us later.",
        code: c`if (USART2->ISR & USART_ISR_RXNE) {
    uint8_t byte = (uint8_t)USART2->RDR;        /* reading RDR clears RXNE */
    uint32_t next = (rx_head + 1u) & RX_MASK;
    if (next != rx_tail) {                      /* drop the byte if the buffer is full */
        rx_buffer[rx_head] = byte;
        rx_head = next;
    }
}`,
        how:
          "Reading `RDR` fetches the byte and clears `RXNE`, which also ends the interrupt request. `next` is where head would move to. " +
          "If that equals tail, the buffer is full and the byte is dropped.\n\n" +
          "One slot always stays empty, so `head == tail` can only mean empty. The byte is stored first and the index moved afterwards, so main never sees a slot that is not yet filled.",
        refs: ['USART.ISR', 'USART.RDR'],
      },
      {
        title: "Handler: clear an overrun",
        why:
          "If a byte arrives while the previous one is still in `RDR`, the UART sets `ORE`. With `RXNEIE` on, `ORE` also requests the interrupt, and it stays set until software clears it.",
        code: c`if (USART2->ISR & USART_ISR_ORE) {
    USART2->ICR = USART_ICR_ORECF;              /* otherwise the interrupt never goes away */
}`,
        how: "The flags of this USART are cleared by writing 1 to the matching bit in `ICR`, the interrupt clear register.",
        refs: ['USART.ICR'],
      },
      {
        title: "Take bytes out in main",
        why: "Main is the consumer: it reads at tail and then moves tail forward.",
        code: c`static int rx_get(uint8_t *byte)
{
    if (rx_tail == rx_head) {
        return 0;
    }
    *byte = rx_buffer[rx_tail];
    rx_tail = (rx_tail + 1u) & RX_MASK;
    return 1;
}`,
        how: "Equal indices mean empty. Otherwise copy the byte out, advance tail with wrap-around, and report success.",
      },
      {
        title: "Drain the buffer after each piece of work",
        why: "During `other_work()` many bytes pile up. All of them must be handled before the next round, or the buffer fills faster than it empties.",
        code: c`other_work();

while (rx_get(&byte)) {
    uart_putc(to_upper((char)byte));
}`,
        how: "`while`, not `if`: the loop runs until the buffer is empty.",
      },
    ],
    mistakes: [
      { mistake: "`if (rx_get(&byte))`", result: "One byte leaves per 3 ms while up to 35 arrive. The buffer fills and long bursts lose bytes." },
      { mistake: "Calling `uart_putc()` from the handler", result: "The handler waits for the transmitter, a whole byte time, and the next received byte overruns." },
      { mistake: "Indices not `volatile`", result: "With optimisation, main may never notice new data." },
      { mistake: "Not clearing `ORE`", result: "After the first overrun the interrupt fires for ever and main stops." },
    ],
    say:
      "The UART holds one byte, and at 115200 baud the next one arrives 87 microseconds later, so polling from a busy main loop overruns. I receive in the RXNE interrupt into a ring buffer. " +
      "The handler only writes head and main only writes tail, so no locking is needed. The size is a power of two for cheap wrap-around, one slot stays free to tell full from empty, and I clear overrun errors so the interrupt cannot stick.",
  },

  'low-power': {
    idea:
      "Replace waiting by sleeping. A timer interrupt fires every 500 ms and toggles the LED. Between interrupts the CPU executes `WFI` and stands still.",
    steps: [
      {
        title: "Let a timer do the time keeping",
        why: "The busy-wait delay keeps the CPU running only to count. A hardware timer counts on its own while the CPU sleeps.",
        code: c`RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
TIM3->PSC = 8000u - 1u;                 /* 8 MHz / 8000 = 1 kHz tick */
TIM3->ARR = 500u - 1u;                  /* update every 500 ms */
TIM3->EGR = TIM_EGR_UG;
TIM3->SR = 0;
TIM3->DIER = TIM_DIER_UIE;
NVIC_EnableIRQ(TIM3_IRQn);
TIM3->CR1 = TIM_CR1_CEN;`,
        how:
          "A prescaler of 8000 gives a 1 ms tick, and 500 ticks give one update every 500 ms. Then the sequence from the timer exercise: " +
          "force an update to load the prescaler, clear the flag it sets, enable the interrupt in the timer and in the NVIC, start the counter.",
        refs: ['RCC.APB1ENR', 'TIM.PSC', 'TIM.ARR', 'TIM.DIER'],
      },
      {
        title: "Toggle in the handler",
        why: "The only work left is to flip the pin twice per second.",
        code: c`void TIM3_IRQHandler(void)
{
    if (TIM3->SR & TIM_SR_UIF) {
        TIM3->SR = ~TIM_SR_UIF;
        GPIOA->ODR ^= 1u << 5;
    }
}`,
        how: "Check the update flag, clear it by writing 0 to it, toggle PA5.",
        refs: ['TIM.SR'],
      },
      {
        title: "Sleep in the main loop",
        why: "`WFI`, wait for interrupt, stops the CPU clock until an enabled interrupt arrives. The timer keeps counting, because peripherals stay clocked in Sleep mode.",
        code: c`for (;;) {
    __WFI();                            /* sleep until the next interrupt */
}`,
        how:
          "On wake-up the CPU runs the handler, returns to the instruction after `WFI`, and the loop puts it back to sleep. Per interrupt it is awake for a few dozen clock cycles out of 4 million.\n\n" +
          "A 1 kHz SysTick would also keep the time, but it would wake the CPU 1000 times per second for nothing. Fewer wake-ups mean a lower average current.",
        refs: ['__WFI'],
      },
    ],
    mistakes: [
      { mistake: "Keeping `delay_ms()` and adding `__WFI()` after it", result: "The delay loop still burns the full 500 ms. The CPU is asleep for almost none of the time." },
      { mistake: "`__WFI()` with no interrupt enabled", result: "Nothing can wake the CPU: it sleeps for ever and the LED never changes." },
      { mistake: "Not clearing `UIF`", result: "The interrupt is immediately pending again, so the CPU never gets to sleep." },
    ],
    say:
      "A busy-wait draws full run current to do nothing. I let a hardware timer generate the 500 ms event and put the CPU into Sleep with WFI in the main loop, so it only wakes to service the interrupt. " +
      "The fewer wake-ups, the lower the average current. For bigger savings I would look at Stop mode with a low-power wake-up source, which needs more care with clocks.",
  },

  'i2c-sensor': {
    idea:
      "Reading a sensor register over I2C is two transfers back to back: first write one byte that says which register, then read the data. The bus is not released in between: the second transfer begins with a repeated START. " +
      "On this chip each transfer is described by one write to `CR2`, and the hardware then asks for bytes or delivers them through flags.",
    steps: [
      {
        title: "Set up the pins as open-drain alternate function",
        why:
          "On I2C nobody drives a line high. Devices only pull it low, and resistors pull it back up. A push-pull pin would fight a device that pulls low, so both pins must be open-drain.",
        code: c`RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
RCC->APB1ENR |= RCC_APB1ENR_I2C1EN;

/* PB6 = SCL, PB7 = SDA: alternate function 1, open-drain (the board has the pull-ups) */
GPIOB->MODER = (GPIOB->MODER & ~(GPIO_MODER_MODER6 | GPIO_MODER_MODER7)) | GPIO_MODER_MODER6_1 | GPIO_MODER_MODER7_1;
GPIOB->OTYPER |= GPIO_OTYPER_OT_6 | GPIO_OTYPER_OT_7;
GPIOB->AFR[0] = (GPIOB->AFR[0] & ~0xFF000000u) | 0x11000000u;`,
        how:
          "`OTYPER` has one bit per pin, and 1 means open-drain. In `AFR[0]` the fields of pins 6 and 7 are bits 27:24 and 31:28, " +
          "so the mask is 0xFF000000 and function 1 on both pins is 0x11000000.",
        refs: ['RCC.APB1ENR', 'GPIO.MODER', 'GPIO.OTYPER', 'GPIO.AFR'],
      },
      {
        title: "Set the bus speed and enable the peripheral",
        why: "The I2C clock is generated from the 8 MHz system clock by a set of timing values.",
        code: c`I2C1->TIMINGR = 0x10420F13;             /* 100 kHz from the 8 MHz HSI */
I2C1->CR1 = I2C_CR1_PE;`,
        how:
          "`TIMINGR` packs a prescaler and the high, low, setup and hold times of the clock. Nobody calculates it by hand: the value comes from the table in the reference manual or from ST's configuration tool. " +
          "`PE` is the peripheral enable bit.",
        refs: ['I2C.TIMINGR', 'I2C.CR1'],
      },
      {
        title: "Transfer 1: send the register number",
        why: "The sensor has several registers. The first byte written after the address tells it which one the following read is about.",
        code: c`I2C1->CR2 = ((uint32_t)addr << 1) | (1u << I2C_CR2_NBYTES_Pos) | I2C_CR2_START;
...
I2C1->TXDR = reg;
while (!(I2C1->ISR & I2C_ISR_TC)) {
}`,
        how:
          "`CR2` carries the whole plan: the 7-bit address shifted left by one, the number of bytes in `NBYTES`, the write direction (the read bit is left at 0), and `START` to begin. " +
          "The hardware sends the address and sets `TXIS` when it wants the data byte, which goes into `TXDR`.\n\n" +
          "`AUTOEND` is not set, so after the byte the hardware keeps hold of the bus and sets `TC`, transfer complete, instead of sending a STOP.",
        refs: ['I2C.CR2', 'I2C.TXDR', 'I2C.ISR'],
      },
      {
        title: "Handle a device that does not answer",
        why: "If no device has this address, nobody acknowledges and `TXIS` never comes. A loop that waits only for `TXIS` would hang for ever.",
        code: c`while (!(I2C1->ISR & (I2C_ISR_TXIS | I2C_ISR_NACKF))) {
}
if (I2C1->ISR & I2C_ISR_NACKF) {        /* nobody answered: the hardware sends the STOP */
    while (!(I2C1->ISR & I2C_ISR_STOPF)) {
    }
    I2C1->ICR = I2C_ICR_NACKCF | I2C_ICR_STOPCF;
    return 0;
}`,
        how:
          "The loop waits for either flag. On `NACKF` the hardware ends the transfer with a STOP by itself. The code waits for that, " +
          "clears both flags by writing 1 to them in `ICR`, and reports failure to the caller.",
        refs: ['I2C.ISR', 'I2C.ICR'],
      },
      {
        title: "Transfer 2: repeated START and read",
        why: "Now the data is fetched. Starting again without a STOP in between keeps the bus, so the two halves cannot be separated by another master.",
        code: c`I2C1->CR2 = ((uint32_t)addr << 1) | I2C_CR2_RD_WRN | (count << I2C_CR2_NBYTES_Pos) | I2C_CR2_AUTOEND | I2C_CR2_START;

for (uint32_t i = 0; i < count; i++) {
    while (!(I2C1->ISR & I2C_ISR_RXNE)) {
    }
    buffer[i] = (uint8_t)I2C1->RXDR;
}
while (!(I2C1->ISR & I2C_ISR_STOPF)) {
}
I2C1->ICR = I2C_ICR_STOPCF;
return 1;`,
        how:
          "The same address, now with `RD_WRN` set for reading, `count` bytes, and `AUTOEND` so that the hardware sends the STOP after the last byte. " +
          "Writing `START` while the bus is still held produces the repeated START.\n\n" +
          "`RXNE` signals each received byte, and reading `RXDR` clears it. At the end the STOP flag is awaited and cleared, so the next call starts clean.",
        refs: ['I2C.CR2', 'I2C.RXDR', 'I2C.ICR'],
      },
      {
        title: "Convert the two bytes",
        why: "The sensor's datasheet defines the format: high byte first, a signed 12-bit value in the upper 12 of the 16 bits, 0.0625 degrees per count.",
        code: c`int16_t raw = (int16_t)(((uint16_t)data[0] << 8) | data[1]);
int32_t counts = raw >> 4;              /* 12-bit value, 1/16 degree per count */
temperature_x10 = (counts * 10) / 16;`,
        how:
          "Join the bytes into 16 bits. The cast to `int16_t` makes the top bit the sign. Shifting right by 4 drops the four unused low bits and keeps the sign, because the value is signed " +
          "(GCC shifts negative values arithmetically; the C standard leaves that to the compiler).\n\n" +
          "0.0625 is 1/16, so tenths of a degree are counts x 10 / 16. For 23.5 C the sensor sends 376 counts, and 376 x 10 / 16 = 235.",
      },
    ],
    mistakes: [
      { mistake: "Pins left push-pull", result: "It may appear to work, but the pin fights the sensor whenever the sensor pulls the line low. The simulator shows a hint and the check fails." },
      { mistake: "The address written without `<< 1`", result: "The hardware sends address 0x24. Nobody answers, and every read ends in a NACK." },
      { mistake: "`uint16_t raw`", result: "Negative temperatures come out as large positive values." },
      { mistake: "Waiting only for `TXIS`", result: "With the sensor unplugged, the firmware hangs in the wait loop." },
    ],
    say:
      "Both pins are open-drain because I2C is a wired-AND bus with pull-ups. A register read is a one-byte write of the register pointer followed by a repeated START and a read. " +
      "On this family I program address, direction and byte count in CR2, feed TXDR on TXIS and read RXDR on RXNE, with AUTOEND generating the STOP. " +
      "I always handle NACK so a missing device cannot hang the code, and I convert the result with a signed type so negative temperatures stay negative.",
  },

  'spi-shift-register': {
    idea:
      "SPI pushes one byte out on the data line, one bit per clock pulse, into the shift register chip. The chip keeps the new bits hidden until its latch pin sees a rising edge; then all eight outputs change together. " +
      "So: send a byte, pulse the latch, and repeat every 100 ms with the lit bit moved up by one.",
    steps: [
      {
        title: "Clock SPI2 and hand over the pins",
        why: "PB13 and PB15 must be driven by the SPI peripheral, and PB12 stays an ordinary output for the latch.",
        code: c`RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
RCC->APB1ENR |= RCC_APB1ENR_SPI2EN;

/* PB12 = latch (output), PB13 = SCK and PB15 = MOSI (alternate function 0, the reset value of AFR) */
GPIOB->MODER = (GPIOB->MODER & ~(GPIO_MODER_MODER12 | GPIO_MODER_MODER13 | GPIO_MODER_MODER15))
             | GPIO_MODER_MODER12_0 | GPIO_MODER_MODER13_1 | GPIO_MODER_MODER15_1;
GPIOB->AFR[1] &= ~((0xFu << ((13 - 8) * 4)) | (0xFu << ((15 - 8) * 4)));`,
        how:
          "One write to `MODER` sets three fields: output (`01`) for PB12, alternate function (`10`) for PB13 and PB15. " +
          "Function 0 is the reset value of `AFR`, so the two fields only need clearing; doing it explicitly does not rely on what ran before.\n\n" +
          "MISO is not connected: the 74HC595 sends nothing useful back.",
        refs: ['RCC.APB1ENR', 'GPIO.MODER', 'GPIO.AFR'],
      },
      {
        title: "Select 8-bit frames",
        why: "The SPI of this chip family can send frames of 4 to 16 bits, so the size has to be stated.",
        code: c`SPI2->CR2 = (7u << SPI_CR2_DS_Pos) | SPI_CR2_FRXTH;                 /* 8-bit frames, RXNE per byte */`,
        how: "`DS` is the frame size minus one, so 7 means 8 bits. `FRXTH` makes `RXNE` report a single received byte; without it the flag waits for two.",
        refs: ['SPI.CR2'],
      },
      {
        title: "Master mode, then enable",
        why: "The microcontroller generates the clock, so it is the master. The enable bit comes last, after everything else is configured.",
        code: c`SPI2->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_BR_1; /* master, mode 0, 8 MHz / 8 */
SPI2->CR1 |= SPI_CR1_SPE;`,
        how:
          "`MSTR` selects master mode. `SSM` tells the peripheral to ignore its NSS pin and use the `SSI` bit as that pin's level. `SSI` must be 1: " +
          "otherwise the peripheral believes another master is active, raises a mode fault and drops out of master mode.\n\n" +
          "`BR_1` selects the clock divider 8, which gives 1 MHz. `CPOL` and `CPHA` stay 0: that is mode 0, with data sampled on the rising clock edge, which is what the 74HC595 needs.",
        refs: ['SPI.CR1'],
      },
      {
        title: "Send one byte and wait until it is out",
        why: "After the data register is written, the byte still takes 8 clock pulses to leave. Latching before that would show a half-shifted pattern.",
        code: c`/* The data register is 16 bits wide in the header; an 8-bit frame needs an 8-bit access. */
#define SPI2_DR8 (*(volatile uint8_t *)&SPI2->DR)
...
static void spi_send(uint8_t value)
{
    while (!(SPI2->SR & SPI_SR_TXE)) {
    }
    SPI2_DR8 = value;
    while (!(SPI2->SR & SPI_SR_RXNE)) {     /* a byte always comes back: wait for it ... */
    }
    (void)SPI2_DR8;                         /* ... and read it so the receive FIFO stays empty */
}`,
        how:
          "`TXE` says there is room in the transmit buffer. The write goes through `SPI2_DR8`, a byte-wide view of the data register: the header declares `DR` as 16 bits, and a 16-bit write would queue two bytes.\n\n" +
          "SPI always receives while it sends, so when `RXNE` is set the 8 clock pulses are complete. That makes it a convenient signal that the byte is out. " +
          "The received byte is read and thrown away, to keep the receive FIFO empty.",
        refs: ['SPI.SR', 'SPI.DR'],
      },
      {
        title: "Pulse the latch",
        why: "The shift register's outputs only change on a rising edge of the latch pin, so the LEDs never show a pattern that is half shifted in.",
        code: c`static void show(uint8_t pattern)
{
    spi_send(pattern);
    GPIOB->BSRR = 1u << 12;                 /* rising edge copies the shift register to the outputs */
    GPIOB->BSRR = 1u << (12 + 16);
}`,
        how: "PB12 goes high, then low again ready for next time. Two `BSRR` writes are enough: the chip needs only nanoseconds.",
        refs: ['GPIO.BSRR'],
      },
      {
        title: "Move the light",
        why: "Exactly one LED is lit, and its position goes up by one every 100 ms and wraps from 7 to 0.",
        code: c`if (ms_ticks - last >= 100u) {
    last += 100u;
    position = (uint8_t)((position + 1u) & 7u);
    show((uint8_t)(1u << position));
}`,
        how:
          "`position` runs from 0 to 7, and `& 7u` wraps 8 back to 0. `1u << position` is a byte with exactly that bit set.\n\n" +
          "SPI sends the most significant bit first by default and the first bit sent ends up on Q7, so bit 7 of the byte is Q7 and bit 0 is Q0.",
      },
    ],
    mistakes: [
      { mistake: "`SSM` without `SSI`", result: "Mode fault: the peripheral leaves master mode and nothing is sent. The simulator explains it under Hints." },
      { mistake: "`SPI2->DR = value;`", result: "Two bytes are sent, the value and then a zero. The zero is what ends up in the shift register: all LEDs off." },
      { mistake: "Latching right after writing the data register", result: "The latch pulse comes before the bits have arrived, so the bar shows the previous pattern." },
      { mistake: "Never reading the data register", result: "The receive FIFO overflows and the overrun flag is set." },
    ],
    say:
      "I configure SPI2 as master with software slave management, which needs SSI set to avoid a mode fault, and 8-bit frames with the FIFO threshold at one byte. " +
      "I write the data register with an 8-bit access, wait for RXNE as the sign that the frame is complete, and then pulse the latch so all outputs change at once. " +
      "The 74HC595 samples on the rising clock edge, so mode 0 fits.",
  },

  'spi-accelerometer': {
    idea:
      "Every exchange with the sensor is a framed transaction: chip select low, one command byte (the register address plus a read flag), the data bytes, chip select high. " +
      "Wrap that in three small functions (read one, write one, read many) and the main program reads like the datasheet: check the identity, switch on, read the axes.",
    steps: [
      {
        title: "Chip-select helpers",
        why: "Chip select tells the sensor where a transaction begins and ends. Named helpers keep the polarity in one place.",
        code: c`static void cs_low(void)  { GPIOB->BSRR = 1u << (11 + 16); }
static void cs_high(void) { GPIOB->BSRR = 1u << 11; }`,
        how: "Chip select is active low. `BSRR` bit 27 (11 + 16) pulls PB11 low and bit 11 releases it.",
        refs: ['GPIO.BSRR'],
      },
      {
        title: "Read one register",
        why: "To read, the master still has to send: every received bit needs a clock pulse, and clock pulses only happen while a byte is being sent.",
        code: c`static uint8_t sensor_read(uint8_t reg)
{
    cs_low();
    spi_transfer((uint8_t)(CMD_READ | reg));
    uint8_t value = spi_transfer(0x00);     /* dummy byte: only there to make clock pulses */
    cs_high();
    return value;
}`,
        how:
          "The command byte is the register number with bit 7 set (`CMD_READ`), which means read. What comes back during that byte is meaningless. " +
          "The second transfer sends a dummy 0x00 to produce eight more clock pulses, and the byte that comes back during them is the register's content.",
      },
      {
        title: "Write one register",
        why: "Configuration is written the same way, with the read flag left clear.",
        code: c`static void sensor_write(uint8_t reg, uint8_t value)
{
    cs_low();
    spi_transfer(reg);
    spi_transfer(value);
    cs_high();
}`,
        how: "Bit 7 clear means write: the command byte is just the register number, followed by the value.",
      },
      {
        title: "Read several registers in one transaction",
        why: "X, Y and Z should come from the same measurement. One transaction guarantees that; three separate reads could straddle an update of the sensor.",
        code: c`static void sensor_read_burst(uint8_t reg, uint8_t *buffer, uint32_t count)
{
    cs_low();
    spi_transfer((uint8_t)(CMD_READ | CMD_AUTO_INC | reg));
    for (uint32_t i = 0; i < count; i++) {
        buffer[i] = spi_transfer(0x00);
    }
    cs_high();
}`,
        how: "`CMD_AUTO_INC` (bit 6) tells the sensor to move on to the next register after every byte, so six dummy bytes fetch six consecutive registers.",
      },
      {
        title: "Convert two bytes to mg",
        why: "The datasheet gives the format: low byte first, a signed value, 12 significant bits at the top of the 16.",
        code: c`/* Little-endian, signed, left-justified 12 bits: cast first so the shift keeps the sign. */
static int32_t to_mg(uint8_t low, uint8_t high)
{
    int16_t raw = (int16_t)(((uint16_t)high << 8) | low);
    return raw >> 4;
}`,
        how:
          "The high byte is shifted up and joined with the low byte. The cast to `int16_t` comes before the shift, so the shift keeps the sign. " +
          "Shifting right by 4 removes the unused low bits, and the result is the acceleration in mg.",
      },
      {
        title: "Identify, switch on, read for ever",
        why: "The identity register is the first thing any driver reads: a correct answer proves that wiring, SPI mode and chip select all work.",
        code: c`who_am_i = sensor_read(REG_WHO_AM_I);
sensor_write(REG_CTRL_REG1, 0x47);      /* 50 Hz, X, Y and Z enabled */

for (;;) {
    uint8_t data[6];

    sensor_read_burst(REG_OUT_X_L, data, 6);
    accel_x_mg = to_mg(data[0], data[1]);
    accel_y_mg = to_mg(data[2], data[3]);
    accel_z_mg = to_mg(data[4], data[5]);
}`,
        how:
          "0x47 in CTRL_REG1 selects a 50 Hz data rate and enables all three axes. Before that the sensor is in power-down and every axis reads 0.\n\n" +
          "The six bytes arrive as X low, X high, Y low, Y high, Z low, Z high.",
      },
    ],
    mistakes: [
      { mistake: "Leaving chip select low between transfers", result: "The sensor takes the next command byte for data, and everything after that is wrong." },
      { mistake: "Not writing CTRL_REG1", result: "WHO_AM_I is correct but all axes read 0: the sensor is still powered down." },
      { mistake: "Forgetting `CMD_READ`", result: "The transaction is a write. You overwrite the register you meant to read." },
      { mistake: "`uint16_t` in place of `int16_t`", result: "Negative accelerations show up as values around +4000 mg." },
    ],
    say:
      "Each transaction is framed by chip select: low, command byte with the read bit and the register address, data bytes, high. To read I clock out dummy bytes. " +
      "I read WHO_AM_I first to prove the bus works, then enable the sensor, because it powers up in power-down mode. I burst-read all six output bytes with auto-increment so the axes belong to one sample, " +
      "and I combine them low byte first as a signed value before shifting.",
  },

  'c-drills': {
    idea: "Six short functions, each built on one idea that is worth knowing by heart, because the same ideas appear in every register access.",
    steps: [
      {
        title: "Count the set bits",
        why: "`x & (x - 1)` clears the lowest set bit: subtracting 1 turns that bit into 0 and all bits below it into 1, and the AND removes them again.",
        code: c`/* Kernighan's method: each pass clears the lowest set bit. */
uint32_t count_set_bits(uint32_t x)
{
    uint32_t count = 0;
    while (x != 0u) {
        x &= x - 1u;
        count++;
    }
    return count;
}`,
        how: "The loop runs once per set bit, not 32 times. Example: binary 1100 becomes 1000, then 0, so the count is 2.",
      },
      {
        title: "Reverse the bits",
        why: "Bits leave the input at the bottom and enter the result at the bottom, so the first one out travels furthest.",
        code: c`uint32_t reverse_bits(uint32_t x)
{
    uint32_t result = 0;
    for (uint32_t i = 0; i < 32u; i++) {
        result = (result << 1) | (x & 1u);
        x >>= 1;
    }
    return result;
}`,
        how: "Take the lowest bit of `x`, push it into `result` from the right, shift `x` down. After 32 rounds the first bit taken has reached bit 31.",
      },
      {
        title: "Swap the byte order",
        why: "The Cortex-M stores the lowest byte at the lowest address (little-endian), while network protocols send the highest byte first, so values have to be converted.",
        code: c`uint32_t swap_endian32(uint32_t x)
{
    return (x << 24) | ((x & 0x0000FF00u) << 8) | ((x >> 8) & 0x0000FF00u) | (x >> 24);
}`,
        how:
          "Each of the four bytes moves to its mirror position: byte 0 up by 24, byte 1 up by 8, byte 2 down by 8, byte 3 down by 24. The masks pick out the two middle bytes. " +
          "`x` is unsigned, so the right shifts fill with zeros.",
      },
      {
        title: "Test for a power of two",
        why: "A power of two has exactly one bit set. Clear the lowest set bit, and nothing is left.",
        code: c`/* A power of two has exactly one bit set, so clearing the lowest set bit leaves zero. */
bool is_power_of_two(uint32_t x)
{
    return x != 0u && (x & (x - 1u)) == 0u;
}`,
        how: "Zero has to be excluded separately: `0 & (0 - 1)` is also 0, but 0 is not a power of two.",
      },
      {
        title: "Update a field in a register value",
        why: "This is the pattern behind every register configuration: clear the field, then OR in the new value.",
        code: c`uint32_t set_field(uint32_t reg, uint32_t mask, uint32_t shift, uint32_t value)
{
    return (reg & ~(mask << shift)) | ((value & mask) << shift);
}`,
        how: "`mask << shift` marks the field, and `& ~` clears it. `value & mask` cuts off the bits of a value that is too large, before they can spill into the neighbouring field.",
      },
      {
        title: "Ring buffer: put",
        why: "Head is the next write position. The buffer is full when moving head forward would make it equal to tail.",
        code: c`/* One slot stays empty so that head == tail can only mean "empty". */
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
}`,
        how:
          "`& (RING_SIZE - 1u)` wraps the index, which works because the size is a power of two. With one slot kept free, a buffer of 8 holds 7 bytes: " +
          "that is the price for telling full from empty without a separate counter.",
      },
      {
        title: "Ring buffer: get and count",
        why: "Tail is the next read position. The buffer is empty when tail has caught up with head.",
        code: c`bool ring_get(ring_t *r, uint8_t *byte)
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
}`,
        how:
          "The count is head minus tail. When head has wrapped around and is numerically behind tail, the unsigned subtraction wraps too, and the mask brings the result back into 0 to 7.",
      },
    ],
    mistakes: [
      { mistake: "Signed types for bit work", result: "`x >> 1` on a negative `int` copies the sign bit, so a loop like `while (x)` never ends, and `1 << 31` is undefined behaviour." },
      { mistake: "`x & (x - 1u) == 0u`", result: "`==` binds tighter than `&`. The expression needs the parentheses around the AND." },
      { mistake: "Leaving out `value & mask` in `set_field()`", result: "A value that is too large corrupts the neighbouring bits. The last test case catches it." },
      { mistake: "A `ring_put()` that overwrites when full", result: "The oldest data is silently destroyed. The harness expects the put to be refused." },
    ],
    say:
      "x and x minus one clears the lowest set bit: that gives both the bit count and the power-of-two test. A field update is clear with the shifted mask, then OR the masked value. " +
      "I use unsigned types throughout, because shifting signed values is a trap. For the ring buffer I keep one slot free to tell full from empty and use a power-of-two size so wrapping is a mask.",
  },
};
