# Pi World

Pi World is the programmable environment exposed to an agent while preserving explicit boundaries around host authority.

## Language

**Virtual Shell**:
A constrained shell environment isolated from the host project and governed by explicit capabilities and resource budgets.
_Avoid_: safe shell, sandbox shell

**Virtual Environment**:
The principal-owned lifetime container for one Virtual Shell instance, its persistent virtual filesystem, execution queue, policy profiles, and cumulative budgets.
_Avoid_: sandbox, shell session

**Virtual Command Set**:
A versioned, policy-owned allowlist of built-in commands and shell implementation versions available in a Virtual Environment.
_Avoid_: installed commands, PATH

**Host Shell**:
A shell environment authorized to operate on the real project and invoke its native toolchain.
_Avoid_: normal shell, system shell

**Host Process Tree**:
The root process and every descendant owned, monitored, and terminated as one contained Host Shell execution.
_Avoid_: child process, command process

**Host Script Profile**:
A policy-owned, fixed interpreter configuration that gives every authorized Host Shell script an explicit dialect identity.
_Avoid_: selected shell, default shell

**Agent Principal**:
The host-established identity of a session root or agent to which shell authority and execution ownership are attached.
_Avoid_: user, caller identity

**Shell Grant**:
An immutable, host-owned set of specific shell capabilities and policy profiles held by one Agent Principal and attenuated for descendants.
_Avoid_: shell access, permissions object

**Shell Terminal Result**:
The versioned, immutable public record of one admitted shell execution's outcome, bounded output, cleanup, and side-effect disposition.
_Avoid_: command response, process result

**Safe Shell Certification**:
The signed, reproducible evidence that one exact release and platform matrix satisfies every mandatory shell contract, adapter, evaluator, and live-agent scenario.
_Avoid_: test run, release checklist

**Command Profile**:
A policy-owned Host Shell command identity binding a resolved executable to fixed arguments and argument, environment, working-directory, and resource constraints.
_Avoid_: command name, executable path

**Network Profile**:
A policy-owned Virtual Shell network identity defining the destinations, methods, redirects, headers, credentials, and budgets available to an execution.
_Avoid_: internet access, fetch permission

**Extension Profile**:
A policy-owned Virtual Shell command extension identity defining trusted implementation and its filesystem, network, and resource authority.
_Avoid_: plugin, custom command permission
