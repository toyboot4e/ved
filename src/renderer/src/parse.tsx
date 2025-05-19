import { Path } from 'slate'

// TODO:
export type RichPos = {
  richPath: Path
  richOffset: number
}

export type PlainPos = {
  plainOffset: number
}

export type Format = Ruby

export type Ruby = {
  delimFront: [number, number]
  text: [number, number]
  sepMid: [number, number]
  rubyText: [number, number]
  delimEnd: [number, number]
}

// TODO: return map of positions
export const parseFormats = (text: string): Format[] => {
  const formats: Format[] = []
  // TODO: what type? map?
  const plainToRich: Map<PlainPos, RichPos> = {}

  let offset = 0
  let iChild = 0
  while (true) {
    offset = text.indexOf('|', offset)
    if (offset === -1) break

    const l = text.indexOf('(', offset)
    if (l === -1) break

    const r = text.indexOf(')', l)
    if (r === -1) break

    iChild += 1
    formats.push({
      delimFront: [offset, offset + 1],
      text: [offset + 1, l],
      sepMid: [l, l + 1],
      rubyText: [l + 1, r],
      delimEnd: [r, r + 1]
    })

    offset = r
    iChild += 1
  }

  return formats
}
