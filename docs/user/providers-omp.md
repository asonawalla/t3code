# OMP

T3 Code connects directly to [Oh My Pi](https://github.com/can1357/oh-my-pi), using its native
models, tools, extensions, skills, and session history.

## Set up OMP

Install OMP 18.18.3 or newer on the machine running the T3 Code server. Run `omp` there to sign in
or configure a model provider, then enable **OMP** in **Settings → Providers** and refresh its
status. Set **Binary path** if the executable is outside the server's `PATH`.

OMP reads its normal configuration for the project. For a separate account or configuration,
add another OMP instance and set its environment variables, such as `PI_CODING_AGENT_DIR`. Mark
API keys as sensitive. Sign-in stays in OMP on the server, including when you use T3 Code remotely.

Existing OMP instances configured as local ACP commands keep working. Select **OMP** for native
integration in new threads. Switching an existing ACP thread to OMP transfers conversation
context through T3 Code's [provider handoff](./portable-handoffs.md).

## Work with native features

Choose from OMP's available models and their supported thinking levels in the composer. Models
that support Fast mode expose that option too. Image attachments go to OMP as images. Context
usage follows OMP's own accounting, and `/compact` summarizes the conversation.

The `/` menu includes OMP's available commands, including skills, extensions, prompt templates,
and MCP prompts for the current project. OMP's configuration continues to control its native
tools, memory, rules, and extensions. Interactive questions and approval requests appear in T3
Code; command output, extension notifications, and phased todos appear in the conversation.

Use `/goal <objective>` to start work that continues across native turns. `/goal` shows the
current goal; `/goal pause`, `/goal resume`, and `/goal clear` control it. **Stop** pauses an
active goal and stops its current work. The goal display includes OMP's reported token usage
and budget when one is set. OMP's own completion, budget, and no-progress rules determine when
automatic continuation ends.

Native subagents appear in the thread's subagent list with live progress and results. Open a
child to inspect its read-only conversation, reasoning, and tools as OMP saves each message.
You can stop individual children. **Stop** also stops background work that could otherwise wake
the agent later. Sending another message
resumes the persisted conversation. Use T3 Code's thread controls for forks and rollback;
commands that replace the conversation or change its working directory are unavailable.

## Permission modes

- **Supervised** asks before native write and execution tools.
- **Auto-accept edits** allows read and write tools, and asks before execution tools.
- **Full access** allows ordinary tools without approval prompts.

OMP's explicit tool policies still apply. Approving its native `task` tool authorizes the
delegated child work without separate child approval dialogs; the approval card explains this.
Explicit child deny rules still deny the operation, and a child operation requiring a prompt
fails because native children run headlessly. These are OMP's tool approvals, not an operating
system sandbox. The Auto reviewer mode is unavailable.

Changing the permission mode restarts the provider and resumes the conversation. Terminal-only
features such as OMP's interactive plan mode and live voice do not have corresponding controls
in T3 Code. Complete credential prompts in OMP itself; secrets are not collected as ordinary
chat answers.
