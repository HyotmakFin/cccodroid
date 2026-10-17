// seccomp-enosys-run 的回归测试：不靠 libc 的静态程序，父子进程各调一次 faccessat2。
// 编译：cc4 -static -nostdlib -O1 -fno-stack-protector -o s test-static-fork.c
// 裸跑会被 SIGSYS 杀；enosys-run 下父进程得 -38、子进程仍被杀；enosys-run -f 下两边都得 -38。
// 不依赖 libc 的静态程序：直接发系统调用（像 CGO_ENABLED=0 的 Go 程序那样）
typedef long L;
static L sc(L n, L a, L b, L c, L d, L e) {
  register L x8 __asm__("x8") = n, x0 __asm__("x0") = a, x1 __asm__("x1") = b, x2 __asm__("x2") = c, x3 __asm__("x3") = d, x4 __asm__("x4") = e;
  __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2), "r"(x3), "r"(x4) : "memory");
  return x0;
}
static void out(const char *s) { L n = 0; while (s[n]) n++; sc(64, 1, (L)s, n, 0, 0); }
static void num(L v) { char b[24]; int i = 23; b[i] = 0; int neg = v < 0; if (neg) v = -v; do { b[--i] = '0' + v % 10; v /= 10; } while (v); if (neg) b[--i] = '-'; out(b + i); }
static void probe(const char *who) {
  L r = sc(439, -100, (L)"/", 0, 0, 0);   // faccessat2(AT_FDCWD, "/", F_OK, 0)
  out(who); out(" faccessat2 -> "); num(r); out("\n");
}
void _start(void) {
  probe("parent");
  L pid = sc(220, 17 /* SIGCHLD */, 0, 0, 0, 0);   // clone = fork
  if (pid == 0) { probe("child"); sc(93, 0, 0, 0, 0, 0); }
  int st = 0; sc(260, pid, (L)&st, 0, 0, 0);          // wait4
  if ((st & 0x7f) && (st & 0x7f) != 0x7f) { out("child killed by signal "); num(st & 0x7f); out("\n"); }
  else { out("child exit "); num((st >> 8) & 0xff); out("\n"); }
  sc(93, 0, 0, 0, 0, 0);
}
