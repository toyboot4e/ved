import { Path } from 'slate'

// TODO:
export type RichPos = {
  path: Path
  offset: number
} & { __bland: 'richPos' }

export const asRichPos = (x: { path: Path; offset: number }): RichPos => {
  return x as RichPos
}

export type PlainPos = {
  offset: number
} & { __bland: 'plainPos' }

export const asPlainPos = (x: { offset: number }): PlainPos => {
  return x as PlainPos
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
  // TODO: consider other formats than ruby
  const rubies = parseRubies(text)

  // // TODO: assign maps
  // const plainToRich: Map<PlainPos, RichPos> = {}
  // if (rubies.length === 0) {
  //   // TODO: create one-to-one mapping
  //   for (let i = 0; i < text.length; i++) {
  //     // FIXME: use Phantom type?
  //     // FIXME: cannot use PlainPos as key???? oh dear
  //     plainToRich[{ plainOffset: i }] = { richPath: [0], richOffset: i }
  //   }
  // } else {
  //   // zip-like map
  //   for (let ruby of rubies) {
  //     //
  //   }
  // }

  return rubies
}

const parseRubies = (text: string): Format[] => {
  const formats: Format[] = []

  let offset = 0
  while (true) {
    offset = text.indexOf('|', offset)
    if (offset === -1) break

    const l = text.indexOf('(', offset)
    if (l === -1) break

    const r = text.indexOf(')', l)
    if (r === -1) break

    formats.push({
      delimFront: [offset, offset + 1],
      text: [offset + 1, l],
      sepMid: [l, l + 1],
      rubyText: [l + 1, r],
      delimEnd: [r, r + 1]
    })

    offset = r
  }

  return formats
}
