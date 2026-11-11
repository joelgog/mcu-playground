/** The program the sandbox starts with: a small tour of the board. */
export const SANDBOX_MAIN = String.raw`#include "stm32f0xx.h"
#include <stdio.h>

/*
 * Sandbox: write anything you like. This starter blinks the on-board LED,
 * prints over the serial console and lights the red LED while the on-board
 * button is held.
 *
 * Board pin map
 *   PA5   on-board LED            PC13  on-board button (0 = pressed)
 *   PC8   red LED                 PC9   yellow LED
 *   PC10  green LED               PC11  blue LED
 *   PB4 / PB5 / PB0   RGB LED (red / green / blue)
 *   PB8   button A                PB9   button B   (to GND, no pull-up fitted)
 *   PA0   potentiometer           PA1   temperature sensor (500 mV + 10 mV/C)
 *   PA6   light sensor            PA4   buzzer
 *   PB10  servo                   PA7   motor PWM, PB14 / PB15 direction
 *   PA8   ultrasonic trigger      PB3   ultrasonic echo
 *   PC0..PC7   7-segment display, segments a b c d e f g dp
 *   PA2 / PA3  serial console (USART2 TX / RX, 115200 baud)
 */

static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}

int main(void)
{
    /* Peripheral clocks first: without them the registers ignore every write. */
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN | RCC_AHBENR_GPIOCEN;

    /* PA5 and PC8 as outputs (MODER: two bits per pin, 01 = output). */
    GPIOA->MODER = (GPIOA->MODER & ~GPIO_MODER_MODER5) | GPIO_MODER_MODER5_0;
    GPIOC->MODER = (GPIOC->MODER & ~GPIO_MODER_MODER8) | GPIO_MODER_MODER8_0;

    /* 1 ms time base. */
    SysTick_Config(SystemCoreClock / 1000u);

    printf("Hello from the STM32F072!\n");

    uint32_t last_blink = 0;
    uint32_t count = 0;

    for (;;) {
        if (ms_ticks - last_blink >= 500u) {
            last_blink += 500u;
            GPIOA->ODR ^= 1u << 5;
            printf("blink %lu\n", (unsigned long)++count);
        }

        /* On-board button is active low: light the red LED while it is held. */
        if ((GPIOC->IDR & (1u << 13)) == 0u) {
            GPIOC->BSRR = 1u << 8;
        } else {
            GPIOC->BSRR = 1u << (8 + 16);
        }
    }
}
`;
