# nr-pty §3 — семантические метки промпта OSC 133 (как у VS Code / WezTerm / iTerm2):
# A — начало промпта, B — конец промпта (начало ввода), C — команда пошла, D;<код> — конец.
[[ -n $NR_PTY_HOOKED ]] && return
NR_PTY_HOOKED=1
autoload -Uz add-zsh-hook

typeset -g __nr_pty_ran=

# Первым в precmd: код возврата ещё не перебит чужими хуками.
__nr_pty_precmd() {
  local code=$?
  [[ -n $__nr_pty_ran ]] && builtin printf '\e]133;D;%s\a' "$code"
  __nr_pty_ran=
  builtin printf '\e]133;A\a'
}
# Последним: тема могла пересобрать PS1 — метка B в конец промпта.
__nr_pty_prompt() {
  [[ $PS1 == *'133;B'* ]] || PS1="$PS1"$'%{\e]133;B\a%}'
}
__nr_pty_preexec() {
  __nr_pty_ran=1
  builtin printf '\e]133;C\a'
}

precmd_functions=(__nr_pty_precmd ${precmd_functions:#__nr_pty_precmd})
add-zsh-hook precmd __nr_pty_prompt
add-zsh-hook preexec __nr_pty_preexec
