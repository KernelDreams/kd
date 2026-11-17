type Props = {
  title: string
  items: string[]
  onPick?: (item: string) => void
}

export function PickList({ title, items, onPick }: Props) {
  return (
    <section className="pick-list">
      <h2>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item} onClick={() => onPick?.(item)}>
            {item.toUpperCase()}
          </li>
        ))}
      </ul>
    </section>
  )
}
