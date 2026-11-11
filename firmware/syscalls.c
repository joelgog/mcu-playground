/*
 * C library hooks ("system calls") for a bare-metal target.
 *
 * printf() ends up in _write(), which sends the bytes out of USART2 (PA2),
 * the pin wired to the serial console. If you have not set up USART2 yourself,
 * the first printf() configures it for 115200 baud, 8N1.
 */
#include "stm32f0xx.h"
#include <errno.h>
#include <sys/stat.h>
#include <sys/types.h>

extern uint32_t _end;     /* end of .bss = start of the heap (from linker.ld) */

static void console_init(void)
{
    RCC->AHBENR  |= RCC_AHBENR_GPIOAEN;
    RCC->APB1ENR |= RCC_APB1ENR_USART2EN;

    /* PA2 = USART2_TX, PA3 = USART2_RX: alternate function 1 */
    GPIOA->MODER  = (GPIOA->MODER & ~(GPIO_MODER_MODER2 | GPIO_MODER_MODER3))
                  | GPIO_MODER_MODER2_1 | GPIO_MODER_MODER3_1;
    GPIOA->AFR[0] = (GPIOA->AFR[0] & ~0x0000FF00u) | 0x00001100u;

    USART2->BRR = (SystemCoreClock + 115200u / 2u) / 115200u;
    USART2->CR1 = USART_CR1_TE | USART_CR1_RE | USART_CR1_UE;
}

int _write(int fd, const char *buf, int len)
{
    (void)fd;
    if (!(RCC->APB1ENR & RCC_APB1ENR_USART2EN) || !(USART2->CR1 & USART_CR1_UE)) {
        console_init();
    }
    for (int i = 0; i < len; i++) {
        while (!(USART2->ISR & USART_ISR_TXE)) {
        }
        USART2->TDR = (uint8_t)buf[i];
    }
    return len;
}

int _read(int fd, char *buf, int len)
{
    (void)fd;
    if (len <= 0) {
        return 0;
    }
    if (!(RCC->APB1ENR & RCC_APB1ENR_USART2EN) || !(USART2->CR1 & USART_CR1_UE)) {
        console_init();
    }
    while (!(USART2->ISR & USART_ISR_RXNE)) {
    }
    buf[0] = (char)USART2->RDR;
    return 1;
}

void *_sbrk(ptrdiff_t increment)
{
    static uint8_t *heap_end;
    register uint8_t *stack_pointer __asm__("sp");

    if (heap_end == 0) {
        heap_end = (uint8_t *)&_end;
    }
    uint8_t *previous = heap_end;
    if (heap_end + increment + 64 > stack_pointer) {
        errno = ENOMEM;
        return (void *)-1;
    }
    heap_end += increment;
    return previous;
}

int _close(int fd) { (void)fd; return -1; }
int _fstat(int fd, struct stat *st) { (void)fd; st->st_mode = S_IFCHR; return 0; }
int _isatty(int fd) { (void)fd; return 1; }
off_t _lseek(int fd, off_t offset, int whence) { (void)fd; (void)offset; (void)whence; return 0; }
int _getpid(void) { return 1; }
int _kill(int pid, int sig) { (void)pid; (void)sig; errno = EINVAL; return -1; }

void _exit(int status)
{
    (void)status;
    for (;;) {
        __asm__ volatile("bkpt 0xFE");
    }
}
