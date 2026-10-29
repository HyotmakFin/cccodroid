/*
 * seccomp-enosys.so —— 把"被安卓 seccomp 拦下的系统调用"从"进程被 SIGSYS 打死"改成"返回 ENOSYS"。
 *
 * 为什么需要：安卓给应用进程装的 seccomp 过滤器用 SECCOMP_RET_TRAP 处理白名单外的调用 ——
 * 内核跳过这次调用并发 SIGSYS。官方 Claude Code（Bun）没有 SIGSYS 处理函数，于是直接死掉。
 * 实测 Android 14 不放行 epoll_pwait2（Android 15 放行）：claude 在 Android 14 上一跑就 "Bad system call"。
 * 而 Bun 本来就会在 ENOSYS 时退回老的 epoll_pwait —— 只是没机会走到那一步。
 *
 * 做法（与 Chromium 沙箱在 arm64 上一致）：装一个 SIGSYS 处理函数，si_code == SYS_SECCOMP 时
 * 把 x0（系统调用返回值）写成 -ENOSYS 后返回。TRAP 时 PC 已经越过 svc，返回后程序就像收到了 ENOSYS。
 *
 * 不依赖任何 libc（直接发 rt_sigaction），所以 glibc 与 bionic 的加载器都能载它；
 * 由 ld-linux 的 --preload 只挂到 claude 身上。
 */
#include <signal.h>
#include <ucontext.h>

#define SYS_SECCOMP_CODE 1
#define ENOSYS_ 38
#define NR_rt_sigaction 134
#define NR_tgkill 131
#define NR_getpid 172
#define NR_gettid 178
#define NR_write 64

struct k_sigaction {
    void (*handler)(int, siginfo_t *, void *);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

static long raw4(long n, long a, long b, long c, long d) {
    register long x8 __asm__("x8") = n;
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register long x3 __asm__("x3") = d;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2), "r"(x3) : "memory");
    return x0;
}

static void on_sigsys(int sig, siginfo_t *si, void *ctx) {
    (void)sig;
    /* si_errno 是过滤器的 RET_DATA：安卓那层是 0；非零是程序自己的沙箱在拒绝，照默认处理（终止），别降级成 ENOSYS（审查 10-29 第六份 中2） */
    if (si->si_code != SYS_SECCOMP_CODE || si->si_errno != 0) {
        /* 不是安卓 seccomp 引起的（比如别人 kill -SYS）：恢复默认行为再给自己补发一次。
         * 光恢复默认就返回会把这个信号吞掉 —— 外来信号不像 seccomp 陷阱那样会"重新触发"。
         * SA_NODEFER 下处理函数里 SIGSYS 没被屏蔽，补发的这一次立刻按默认处理（终止 + core）。 */
        struct k_sigaction dfl = { 0 };
        raw4(NR_rt_sigaction, SIGSYS, (long)&dfl, 0, 8);
        raw4(NR_tgkill, raw4(NR_getpid, 0, 0, 0, 0), raw4(NR_gettid, 0, 0, 0, 0), SIGSYS, 0);
        return;
    }
    ((ucontext_t *)ctx)->uc_mcontext.regs[0] = (unsigned long)-ENOSYS_;
}

__attribute__((constructor)) static void install(void) {
    struct k_sigaction sa = { 0 };
    sa.handler = on_sigsys;
    sa.flags = SA_SIGINFO | SA_NODEFER;   /* 不设 SA_RESTORER：arm64 内核会用 vDSO 里的 sigreturn */
    /* 装不上就说一声：不然 claude 在第一个被拦的系统调用上被 SIGSYS 打死，日志里只有一个信号号，看不出原因（审查 v0.5.7 L11） */
    if (raw4(NR_rt_sigaction, SIGSYS, (long)&sa, 0, 8) != 0) {
        static const char msg[] = "seccomp-enosys: rt_sigaction(SIGSYS) failed; blocked syscalls will kill this process\n";
        raw4(NR_write, 2, (long)msg, sizeof msg - 1, 0);
    }
}
