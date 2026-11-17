# nr-pty: обёртка ZDOTDIR — свой ~/.zshenv пользователя грузится как обычно.
NR_PTY_ZDOTDIR=$ZDOTDIR
ZDOTDIR=${NR_PTY_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && . $ZDOTDIR/.zshenv
NR_PTY_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$NR_PTY_ZDOTDIR
