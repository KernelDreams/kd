# nr-pty §3 — метки OSC 133 для bash (3.2+): A/B — промпт, C — команда пошла, D;<код> — конец.
[[ -n $NR_PTY_HOOKED ]] && return
NR_PTY_HOOKED=1

__nr_pty_ran=
__nr_pty_in_prompt=
__nr_pty_code=0

__nr_pty_precmd() {
  [[ -n $__nr_pty_ran ]] && builtin printf '\e]133;D;%s\a' "$__nr_pty_code"
  __nr_pty_ran=
  builtin printf '\e]133;A\a'
  [[ $PS1 == *'133;B'* ]] || PS1="$PS1"'\[\e]133;B\a\]'
  __nr_pty_in_prompt=1
}
# DEBUG-ловушка перед первой командой строки — «команда пошла».
__nr_pty_debug() {
  [[ -n $__nr_pty_in_prompt ]] || return
  [[ $BASH_COMMAND == __nr_pty_* ]] && return
  __nr_pty_in_prompt=
  __nr_pty_ran=1
  builtin printf '\e]133;C\a'
}

PROMPT_COMMAND="__nr_pty_code=\$?;${PROMPT_COMMAND:+$PROMPT_COMMAND;}__nr_pty_precmd"
trap '__nr_pty_debug' DEBUG
