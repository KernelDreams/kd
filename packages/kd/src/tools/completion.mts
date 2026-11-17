/**
 * `kd completion zsh|bash|powershell` — скрипт подсказок Tab (kd-cli-spec §6): он спрашивает
 * `kd __complete <слова>` (лёгкая точка без рантайма, ответ из кэша). Печатает скрипт в stdout;
 * поставить — строкой из stderr.
 */

export const tool = {
  description: 'скрипт подсказок Tab для zsh, bash или PowerShell',
  fields: { shell: 'select zsh, bash, powershell $pos=1 // Оболочка' },
  defaults: { shell: 'zsh' },
  examples: ['kd completion zsh > ~/.zsh/completions/_kd', 'kd completion bash >> ~/.bashrc', 'kd completion powershell >> $PROFILE'],
}

const ZSH = `#compdef kd
# kd: подсказки Tab — kd completion zsh > "\${fpath[1]}/_kd"
_kd() {
  local -a items
  local IFS=$'\\n'
  items=($(kd __complete --shell=zsh "\${(@)words[2,CURRENT]}" 2>/dev/null))
  (( \${#items} )) && _describe -t kd 'kd' items
}
compdef _kd kd
`

const BASH = `# kd: подсказки Tab — kd completion bash >> ~/.bashrc
_kd() {
  local IFS=$'\\n'
  COMPREPLY=($(kd __complete --shell=bash "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
}
complete -o nospace -o default -F _kd kd
`

const POWERSHELL = `# kd: подсказки Tab — kd completion powershell >> $PROFILE
Register-ArgumentCompleter -Native -CommandName kd -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
  if ($wordToComplete -eq '') { $words += '' }
  kd __complete --shell=powershell @words 2>$null | ForEach-Object {
    $v, $d = $_ -split "\`t", 2
    if (-not $d) { $d = $v }
    [System.Management.Automation.CompletionResult]::new($v, $v, 'ParameterValue', $d)
  }
}
`

export default function completion(ctx: { get(p: string[]): unknown }): { output: string } {
  const shell = String(ctx.get(['shell']) ?? 'zsh')
  const out = shell === 'bash' ? BASH : shell === 'powershell' ? POWERSHELL : ZSH
  const where = shell === 'bash' ? '~/.bashrc' : shell === 'powershell' ? '$PROFILE' : '"${fpath[1]}/_kd" (или ~/.zshrc)'
  process.stderr.write(`kd: поставить — kd completion ${shell} >> ${where}\n`)
  return { output: out }
}
