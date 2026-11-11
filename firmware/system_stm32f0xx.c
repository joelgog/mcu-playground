/*
 * System clock bookkeeping (CMSIS convention).
 *
 * After reset the chip runs from the internal 8 MHz oscillator (HSI).
 * If you reconfigure the clock tree in RCC, call SystemCoreClockUpdate()
 * so SystemCoreClock holds the new CPU frequency in Hz.
 */
#include "stm32f0xx.h"

#define HSI_HZ   8000000u
#define HSE_HZ   8000000u
#define HSI48_HZ 48000000u

uint32_t SystemCoreClock = HSI_HZ;

static const uint8_t ahb_shift[16] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 6, 7, 8, 9};

void SystemInit(void)
{
    /* Nothing to do: the reset state (HSI, no prescalers) is a valid configuration. */
}

void SystemCoreClockUpdate(void)
{
    uint32_t sysclk;

    switch (RCC->CFGR & RCC_CFGR_SWS) {
    case RCC_CFGR_SWS_HSE:
        sysclk = HSE_HZ;
        break;
    case RCC_CFGR_SWS_PLL: {
        uint32_t mul = ((RCC->CFGR & RCC_CFGR_PLLMUL) >> 18) + 2u;
        uint32_t prediv = (RCC->CFGR2 & RCC_CFGR2_PREDIV) + 1u;
        if (mul > 16u) {
            mul = 16u;
        }
        switch (RCC->CFGR & RCC_CFGR_PLLSRC) {
        case RCC_CFGR_PLLSRC_HSE_PREDIV:
            sysclk = HSE_HZ / prediv * mul;
            break;
        case RCC_CFGR_PLLSRC_HSI48_PREDIV:
            sysclk = HSI48_HZ / prediv * mul;
            break;
        case RCC_CFGR_PLLSRC_HSI_PREDIV:
            sysclk = HSI_HZ / prediv * mul;
            break;
        default: /* HSI / 2 */
            sysclk = HSI_HZ / 2u * mul;
            break;
        }
        break;
    }
    case RCC_CFGR_SWS_HSI48:
        sysclk = HSI48_HZ;
        break;
    default:
        sysclk = HSI_HZ;
        break;
    }

    SystemCoreClock = sysclk >> ahb_shift[(RCC->CFGR & RCC_CFGR_HPRE) >> 4];
}
