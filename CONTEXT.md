# Pi World

Pi World is the programmable environment exposed to an agent while preserving explicit boundaries around host authority.

## Language

**Virtual Shell**:
A constrained shell environment isolated from the host project and governed by explicit capabilities and resource budgets.
_Avoid_: safe shell, sandbox shell

**Host Shell**:
A shell environment authorized to operate on the real project and invoke its native toolchain.
_Avoid_: normal shell, system shell

**Host Script Profile**:
A policy-owned, fixed interpreter configuration that gives every authorized Host Shell script an explicit dialect identity.
_Avoid_: selected shell, default shell

**Agent Principal**:
The host-established identity of a session root or agent to which shell authority and execution ownership are attached.
_Avoid_: user, caller identity

**Shell Grant**:
An immutable, host-owned set of specific shell capabilities and policy profiles held by one Agent Principal and attenuated for descendants.
_Avoid_: shell access, permissions object

**Command Profile**:
A policy-owned Host Shell command identity binding a resolved executable to fixed arguments and argument, environment, working-directory, and resource constraints.
_Avoid_: command name, executable path

**Network Profile**:
A policy-owned Virtual Shell network identity defining the destinations, methods, redirects, headers, credentials, and budgets available to an execution.
_Avoid_: internet access, fetch permission

**Extension Profile**:
A policy-owned Virtual Shell command extension identity defining trusted implementation and its filesystem, network, and resource authority.
_Avoid_: plugin, custom command permission
