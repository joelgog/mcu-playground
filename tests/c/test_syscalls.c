/* Test-only C library hooks: stdout goes to a debug port instead of the USART. */
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/types.h>

#define DEBUG_PORT (*(volatile uint32_t *)0x4000F000u)

extern uint32_t _end;

int _write(int fd, const char *buf, int len)
{
    (void)fd;
    for (int i = 0; i < len; i++) {
        DEBUG_PORT = (uint8_t)buf[i];
    }
    return len;
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

int _read(int fd, char *buf, int len) { (void)fd; (void)buf; (void)len; return 0; }
int _close(int fd) { (void)fd; return -1; }
int _fstat(int fd, struct stat *st) { (void)fd; st->st_mode = S_IFCHR; return 0; }
int _isatty(int fd) { (void)fd; return 1; }
off_t _lseek(int fd, off_t offset, int whence) { (void)fd; (void)offset; (void)whence; return 0; }
int _getpid(void) { return 1; }
int _kill(int pid, int sig) { (void)pid; (void)sig; errno = EINVAL; return -1; }
void _exit(int status) { (void)status; for (;;) { __asm__ volatile("bkpt 0xFE"); } }
