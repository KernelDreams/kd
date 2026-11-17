# nr-pty: обёртка ZDOTDIR — свой ~/.zshrc пользователя, потом метки OSC 133.
NR_PTY_ZDOTDIR=$ZDOTDIR
# /etc/zshrc macOS ставит HISTFILE от ZDOTDIR — история обёртки шла бы в каталог пакета.
[[ $HISTFILE == $NR_PTY_ZDOTDIR/* ]] && HISTFILE=${NR_PTY_USER_ZDOTDIR:-$HOME}/.zsh_history
ZDOTDIR=${NR_PTY_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshrc ]] && . $ZDOTDIR/.zshrc
NR_PTY_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$NR_PTY_ZDOTDIR
. "${NR_PTY_ZDOTDIR:h}/osc133.zsh"
# Не логин-шелл — .zlogin не будет: ZDOTDIR пользователя возвращаем здесь.
[[ -o login ]] || ZDOTDIR=$NR_PTY_USER_ZDOTDIR
