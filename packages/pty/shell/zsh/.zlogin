# nr-pty: обёртка ZDOTDIR — свой ~/.zlogin пользователя грузится как обычно.
NR_PTY_ZDOTDIR=$ZDOTDIR
ZDOTDIR=${NR_PTY_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zlogin ]] && . $ZDOTDIR/.zlogin
NR_PTY_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$NR_PTY_ZDOTDIR
ZDOTDIR=$NR_PTY_USER_ZDOTDIR
