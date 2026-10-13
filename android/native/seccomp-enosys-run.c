/*
 * seccomp-enosys-run —— seccomp-enosys.so 的「从进程外面」版本
 *
 * 为什么需要它：
 *   seccomp-enosys.so 靠 ld-linux 的 --preload 注入，只能挂在**_动态链接**的进程上。
 *   静态二进制（典型是 CGO_ENABLED=0 编出来的 Go 程序 —— gh / lazygit / kubectl /
 *   terraform / hugo …）没有动态加载器，这一招**根本没处挂**：
 *
 *       $ gh pr create --title t --body b
 *       SIGSYS: bad system call
 *       syscall.Syscall6(0x1b7, ...)          ← 0x1b7 = 439 = faccessat2
 *
 *   （实测：gh 的 LookPath 会用 faccessat2 逐个 PATH 目录探测可执行文件找 git，
 *     于是所有需要调用 git 的子命令全崩。而 gh api 不查找任何东西，一直正常 ——
 *     很容易被误判成「就个别命令有毛病」。）
 *
 * 做法：把同一件事从外面做一遍 —— ptrace 监督器。
 *   子进程 PTRACE_TRACEME 后 exec，父进程在信号停里看到 SIGSYS 且
 *   si_code == SYS_SECCOMP 时，把 x0 写成 -ENOSYS 再以 signal 0 放行。
 *   内核本来就没执行那次调用、PC 也已越过 svc，所以程序返回后就当收到了 ENOSYS。
 *
 *   和 on_sigsys 语义完全一致，但：
 *     - 不需要注入 → 静态二进制也能用
 *     - 不需要预先知道哪个 syscall 会被拦
 *     - 不依赖「必须存在一个老的等价 syscall」（逐字节改系统调用号就有这个依赖）
 *     - **完全不改动目标程序**（与 devkit「不需要二进制补丁」的原则一致）
 *
 * 开销：只有真的发生 SIGSYS 才会停一次，日常零开销（用的是 PTRACE_CONT，不是 PTRACE_SYSCALL）。
 *
 * 用法：
 *   seccomp-enosys-run <程序> [参数...]
 *   seccomp-enosys-run -v <程序> [参数...]     # 把每次拦截打到 stderr（排查用）
 *
 * 退出码：目标程序的退出码原样传递。
 */

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef __WALL
#define __WALL 0x40000000
#endif
#ifndef SI_TKILL
#define SI_TKILL (-6)
#endif
#ifndef PTRACE_O_TRACECLONE
#define PTRACE_O_TRACECLONE 0x00000008
#endif
#ifndef PTRACE_O_EXITKILL
#define PTRACE_O_EXITKILL 0x00100000
#endif
#ifndef PTRACE_EVENT_CLONE
#define PTRACE_EVENT_CLONE 3
#endif
#ifndef PTRACE_GETREGSET
#define PTRACE_GETREGSET 0x4204
#endif
#ifndef PTRACE_SETREGSET
#define PTRACE_SETREGSET 0x4205
#endif
#ifndef NT_PRSTATUS
#define NT_PRSTATUS 1
#endif

#define SYS_SECCOMP_CODE 1      /* SIGSYS 的 si_code：由 seccomp 过滤器触发 */
#define ENOSYS_ 38

/* arm64 的 NT_PRSTATUS 内容（struct user_pt_regs）。x0 = regs[0]。
   不包含 <sys/user.h>：bionic 上不一定有，而且这点结构自己写更稳。 */
struct arm64_regs {
    unsigned long regs[31];
    unsigned long sp;
    unsigned long pc;
    unsigned long pstate;
};

static int verbose = 0;

static long get_syscall_nr(pid_t pid, siginfo_t *si) {
    (void)pid;
    /* siginfo 里带着被拦的系统调用号；不同 libc 的字段名不一样，用 memcpy 兜底 */
    long nr = -1;
#ifdef si_syscall
    nr = si->si_syscall;
#else
    /* struct: int signo, int errno, int code, [pad], unsigned long call_addr,
       int syscall, unsigned arch —— 取 offsetof 不现实，这里靠 bionic 的定义 */
#endif
    return nr;
}

/* 把 x0 写成 -ENOSYS。成功返回 0。 */
static int set_return_enosys(pid_t pid) {
    struct arm64_regs regs;
    struct iovec iov;
    memset(&regs, 0, sizeof regs);
    iov.iov_base = &regs;
    iov.iov_len = sizeof regs;

    if (ptrace(PTRACE_GETREGSET, pid, (void *)(long)NT_PRSTATUS, &iov) != 0) {
        return -1;
    }
    regs.regs[0] = (unsigned long)-ENOSYS_;
    iov.iov_len = sizeof regs;
    if (ptrace(PTRACE_SETREGSET, pid, (void *)(long)NT_PRSTATUS, &iov) != 0) {
        return -1;
    }
    return 0;
}

/* 监督循环：返回组长进程的退出码。 */
static int supervise(pid_t leader) {
    int status;
    pid_t pid;
    int exit_code = 127;

    while ((pid = waitpid(-1, &status, __WALL)) > 0) {
        if (WIFEXITED(status)) {
            if (pid == leader) exit_code = WEXITSTATUS(status);
            continue;
        }
        if (WIFSIGNALED(status)) {
            if (pid == leader) exit_code = 128 + WTERMSIG(status);
            continue;
        }
        if (!WIFSTOPPED(status)) continue;

        int sig = WSTOPSIG(status);
        int deliver = sig;

        if (sig == SIGTRAP) {
            /* exec 后的初始停、以及 clone/fork 事件停 —— 都不该往目标程序里投信号 */
            deliver = 0;
        } else if (sig == SIGSYS) {
            siginfo_t si;
            memset(&si, 0, sizeof si);
            if (ptrace(PTRACE_GETSIGINFO, pid, 0, &si) == 0 &&
                si.si_code == SYS_SECCOMP_CODE) {
                if (verbose) {
                    fprintf(stderr, "[enosys] pid %d: 拦下 syscall %ld → ENOSYS\n",
                            (int)pid, get_syscall_nr(pid, &si));
                }
                if (set_return_enosys(pid) == 0) {
                    deliver = 0;        /* 已经"返回"了 ENOSYS，别再投信号 */
                }
                /* 设置寄存器失败就按原样投递：退化成不介入，比吞掉信号安全 */
            }
        } else if (sig == SIGSTOP) {
            siginfo_t si;
            memset(&si, 0, sizeof si);
            if (ptrace(PTRACE_GETSIGINFO, pid, 0, &si) == 0 &&
                si.si_code == SI_TKILL && si.si_pid == pid) {
                /* 新线程被 PTRACE_O_TRACECLONE 带进来的自动停止：
                   是内核产生的，不是外面发的 SIGSTOP，直接放行。
                   靠 si_pid == 自己 区分，这样用户真的发 SIGSTOP 时不会被吞掉。 */
                deliver = 0;
            }
        }

        if (ptrace(PTRACE_CONT, pid, 0, deliver) != 0) {
            if (errno == ESRCH) continue;   /* 线程刚好没了，无所谓 */
            perror("ptrace(PTRACE_CONT)");
            return 127;
        }
    }
    return exit_code;
}

static void usage(const char *argv0) {
    fprintf(stderr,
        "用法: %s [-v] <程序> [参数...]\n"
        "\n"
        "把被安卓 seccomp 拦下的系统调用改成返回 ENOSYS，让程序能优雅退回老接口。\n"
        "动态链接的程序用 seccomp-enosys.so（--preload），静态二进制用这个。\n"
        "\n"
        "  -v   把每次拦截打到 stderr\n", argv0);
}

int main(int argc, char **argv) {
    int argi = 1;
    while (argi < argc && argv[argi][0] == '-' && argv[argi][1] != '\0') {
        if (strcmp(argv[argi], "-v") == 0 || strcmp(argv[argi], "--verbose") == 0) {
            verbose = 1;
            argi++;
        } else if (strcmp(argv[argi], "-h") == 0 || strcmp(argv[argi], "--help") == 0) {
            usage(argv[0]);
            return 0;
        } else {
            break;              /* 不认识的选项：交给目标程序自己解释 */
        }
    }
    if (argi >= argc) {
        usage(argv[0]);
        return 2;
    }

    fflush(NULL);               /* fork 前清干净，别让缓冲区被复制成两份 */

    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 127;
    }

    if (pid == 0) {
        /* 子进程 */
        if (ptrace(PTRACE_TRACEME, 0, 0, 0) != 0) {
            /* 拦不住跟踪就照常跑 —— 退化成"没有这个工具"，而不是拒绝启动。
               某些 SELinux 策略会拒绝，这里不该因此把用户挡在门外。 */
            fprintf(stderr, "[enosys] 警告: PTRACE_TRACEME 失败(%s)，将不做拦截\n",
                    strerror(errno));
        }
        execvp(argv[argi], &argv[argi]);
        fprintf(stderr, "%s: 无法执行 %s: %s\n", argv[0], argv[argi], strerror(errno));
        _exit(127);
    }

    /* 父进程：先等 exec 后的初始 SIGTRAP，再设选项 */
    int status;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        return 127;
    }
    if (!WIFSTOPPED(status)) {
        /* 还没进跟踪就结束了（比如 exec 失败） */
        return WIFEXITED(status) ? WEXITSTATUS(status) : 127;
    }

    long opts = PTRACE_O_TRACECLONE | PTRACE_O_EXITKILL;
    if (ptrace(PTRACE_SETOPTIONS, pid, 0, (void *)opts) != 0) {
        perror("ptrace(PTRACE_SETOPTIONS)");
        return 127;
    }
    /* 自己别被终端的 Ctrl-C 打死：要活着把信号转发给目标、并带回退出码。
       （目标在同一进程组，会直接从内核收到同一个信号，经跟踪转发。） */
    signal(SIGINT, SIG_IGN);
    signal(SIGTERM, SIG_IGN);
    signal(SIGHUP, SIG_IGN);

    if (ptrace(PTRACE_CONT, pid, 0, 0) != 0) {
        perror("ptrace(PTRACE_CONT)");
        return 127;
    }
    return supervise(pid);
}
