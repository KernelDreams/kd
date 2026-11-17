# nr-pty: обёртка ZDOTDIR — свой ~/.zprofile пользователя грузится как обычно.
NR_PTY_ZDOTDIR=$ZDOTDIR
ZDOTDIR=${NR_PTY_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zprofile ]] && . $ZDOTDIR/.zprofile
NR_PTY_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$NR_PTY_ZDOTDIR
