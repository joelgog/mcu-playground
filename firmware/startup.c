/*
 * Startup code for the STM32F072RB.
 *
 * This is what runs before main(): the CPU loads the stack pointer and the
 * address of Reset_Handler from the first two entries of the vector table,
 * then Reset_Handler prepares RAM and calls main().
 *
 * You can edit this file. It is compiled together with your code.
 */
#include <stdint.h>

/* Symbols defined by the linker script (linker.ld). */
extern uint32_t _estack;   /* top of RAM = initial stack pointer          */
extern uint32_t _sidata;   /* start of the .data initial values in flash  */
extern uint32_t _sdata;    /* start of .data in RAM                       */
extern uint32_t _edata;    /* end of .data in RAM                         */
extern uint32_t _sbss;     /* start of .bss in RAM                        */
extern uint32_t _ebss;     /* end of .bss in RAM                          */

int main(void);
void SystemInit(void);
void __libc_init_array(void);

void _init(void) {}
void _fini(void) {}

void Reset_Handler(void)
{
    /* 1. Copy initialised globals (.data) from flash to RAM. */
    uint32_t *src = &_sidata;
    uint32_t *dst = &_sdata;
    while (dst < &_edata) {
        *dst++ = *src++;
    }

    /* 2. Zero the uninitialised globals (.bss). */
    for (dst = &_sbss; dst < &_ebss; dst++) {
        *dst = 0;
    }

    /* 3. Clock setup hook, C library constructors, then your program. */
    SystemInit();
    __libc_init_array();
    main();

    /* main() should never return on a microcontroller. The playground stops here. */
    for (;;) {
        __asm__ volatile("bkpt 0xFE");
    }
}

/* Any interrupt without its own handler lands here. */
void Default_Handler(void)
{
    for (;;) {
    }
}

#define WEAK_DEFAULT __attribute__((weak, alias("Default_Handler")))

void NMI_Handler(void) WEAK_DEFAULT;
void HardFault_Handler(void) WEAK_DEFAULT;
void SVC_Handler(void) WEAK_DEFAULT;
void PendSV_Handler(void) WEAK_DEFAULT;
void SysTick_Handler(void) WEAK_DEFAULT;
void WWDG_IRQHandler(void) WEAK_DEFAULT;
void PVD_VDDIO2_IRQHandler(void) WEAK_DEFAULT;
void RTC_IRQHandler(void) WEAK_DEFAULT;
void FLASH_IRQHandler(void) WEAK_DEFAULT;
void RCC_CRS_IRQHandler(void) WEAK_DEFAULT;
void EXTI0_1_IRQHandler(void) WEAK_DEFAULT;
void EXTI2_3_IRQHandler(void) WEAK_DEFAULT;
void EXTI4_15_IRQHandler(void) WEAK_DEFAULT;
void TSC_IRQHandler(void) WEAK_DEFAULT;
void DMA1_Channel1_IRQHandler(void) WEAK_DEFAULT;
void DMA1_Channel2_3_IRQHandler(void) WEAK_DEFAULT;
void DMA1_Channel4_5_6_7_IRQHandler(void) WEAK_DEFAULT;
void ADC1_COMP_IRQHandler(void) WEAK_DEFAULT;
void TIM1_BRK_UP_TRG_COM_IRQHandler(void) WEAK_DEFAULT;
void TIM1_CC_IRQHandler(void) WEAK_DEFAULT;
void TIM2_IRQHandler(void) WEAK_DEFAULT;
void TIM3_IRQHandler(void) WEAK_DEFAULT;
void TIM6_DAC_IRQHandler(void) WEAK_DEFAULT;
void TIM7_IRQHandler(void) WEAK_DEFAULT;
void TIM14_IRQHandler(void) WEAK_DEFAULT;
void TIM15_IRQHandler(void) WEAK_DEFAULT;
void TIM16_IRQHandler(void) WEAK_DEFAULT;
void TIM17_IRQHandler(void) WEAK_DEFAULT;
void I2C1_IRQHandler(void) WEAK_DEFAULT;
void I2C2_IRQHandler(void) WEAK_DEFAULT;
void SPI1_IRQHandler(void) WEAK_DEFAULT;
void SPI2_IRQHandler(void) WEAK_DEFAULT;
void USART1_IRQHandler(void) WEAK_DEFAULT;
void USART2_IRQHandler(void) WEAK_DEFAULT;
void USART3_4_IRQHandler(void) WEAK_DEFAULT;
void CEC_CAN_IRQHandler(void) WEAK_DEFAULT;
void USB_IRQHandler(void) WEAK_DEFAULT;

typedef void (*vector_t)(void);

/* The vector table. The linker script places it at the very start of flash. */
__attribute__((section(".isr_vector"), used))
const vector_t g_vector_table[] = {
    (vector_t)&_estack,          /*  0  initial stack pointer */
    Reset_Handler,               /*  1  reset                 */
    NMI_Handler,                 /*  2                        */
    HardFault_Handler,           /*  3                        */
    0, 0, 0, 0, 0, 0, 0,         /*  4-10 reserved            */
    SVC_Handler,                 /* 11                        */
    0, 0,                        /* 12-13 reserved            */
    PendSV_Handler,              /* 14                        */
    SysTick_Handler,             /* 15                        */
    /* External interrupts (IRQ 0..31) */
    WWDG_IRQHandler,
    PVD_VDDIO2_IRQHandler,
    RTC_IRQHandler,
    FLASH_IRQHandler,
    RCC_CRS_IRQHandler,
    EXTI0_1_IRQHandler,
    EXTI2_3_IRQHandler,
    EXTI4_15_IRQHandler,
    TSC_IRQHandler,
    DMA1_Channel1_IRQHandler,
    DMA1_Channel2_3_IRQHandler,
    DMA1_Channel4_5_6_7_IRQHandler,
    ADC1_COMP_IRQHandler,
    TIM1_BRK_UP_TRG_COM_IRQHandler,
    TIM1_CC_IRQHandler,
    TIM2_IRQHandler,
    TIM3_IRQHandler,
    TIM6_DAC_IRQHandler,
    TIM7_IRQHandler,
    TIM14_IRQHandler,
    TIM15_IRQHandler,
    TIM16_IRQHandler,
    TIM17_IRQHandler,
    I2C1_IRQHandler,
    I2C2_IRQHandler,
    SPI1_IRQHandler,
    SPI2_IRQHandler,
    USART1_IRQHandler,
    USART2_IRQHandler,
    USART3_4_IRQHandler,
    CEC_CAN_IRQHandler,
    USB_IRQHandler,
};
