// game.ts — the TS service shows diagnostics, completion and hover.

interface Player {
  name: string
  hp: number
  inventory: Item[]
}

interface Item {
  id: string
  weight: number
}

function totalWeight(player: Player): number {
  return player.inventory.reduce((sum, item) => sum + item.weight, 0)
}

const hero: Player = {
  name: 'Mira',
  hp: 'full', // intentional type error: string is not assignable to number
  inventory: [{ id: 'sword', weight: 3 }],
}

export function heal(player: Player, amount: number): Player {
  return { ...player, hp: Math.min(100, player.hp + amount) }
}

console.log(totalWeight(hero), heal(hero, 10).hp)
