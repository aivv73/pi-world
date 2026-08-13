# Pi World

Pi World is the programmable environment exposed to an agent while preserving explicit boundaries around host authority.

## Language

**Virtual Shell**:
A constrained shell environment isolated from the host project and governed by explicit capabilities and resource budgets.
_Avoid_: safe shell, sandbox shell

**Host Shell**:
A shell environment authorized to operate on the real project and invoke its native toolchain.
_Avoid_: normal shell, system shell
