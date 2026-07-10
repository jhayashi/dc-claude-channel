import { describe, test, expect } from 'bun:test'
import { postTurnResult, denialSummary } from '../dispatcher/turn-post.js'

function makeSend() {
  const sent: Array<{ chatId: number; text: string }> = []
  const send = async (chatId: number, text: string) => {
    sent.push({ chatId, text })
    return sent.length // fake msgId
  }
  return { sent, send }
}

describe('denialSummary', () => {
  test('null for no denials', () => {
    expect(denialSummary([])).toBeNull()
  })

  test('formats tool name and truncated command', () => {
    const s = denialSummary([
      { tool_name: 'Bash', command: 'rm -rf /tmp/x' },
      { tool_name: 'Edit' },
    ])
    expect(s).toContain('blocked by policy')
    expect(s).toContain('• Bash: rm -rf /tmp/x')
    expect(s).toContain('• Edit')
  })

  test('truncates long commands to 80 chars', () => {
    const long = 'x'.repeat(200)
    const s = denialSummary([{ tool_name: 'Bash', command: long }])!
    expect(s).toContain('x'.repeat(80))
    expect(s).not.toContain('x'.repeat(81))
  })
})

describe('postTurnResult', () => {
  test('posts result text to the chat', async () => {
    const { sent, send } = makeSend()
    await postTurnResult(send, 42, { text: 'the reply', denials: [] })
    expect(sent).toEqual([{ chatId: 42, text: 'the reply' }])
  })

  test('posts denial summary as a second message', async () => {
    const { sent, send } = makeSend()
    await postTurnResult(send, 42, {
      text: 'partial work done',
      denials: [{ tool_name: 'Bash', command: 'mkdir x' }],
    })
    expect(sent.length).toBe(2)
    expect(sent[0].text).toBe('partial work done')
    expect(sent[1].text).toContain('blocked by policy')
    expect(sent[1].text).toContain('• Bash: mkdir x')
  })

  test('posts nothing for empty text and no denials', async () => {
    const { sent, send } = makeSend()
    await postTurnResult(send, 42, { text: '', denials: [] })
    expect(sent).toEqual([])
  })

  test('posts only denials when text is empty', async () => {
    const { sent, send } = makeSend()
    await postTurnResult(send, 7, { text: '', denials: [{ tool_name: 'WebFetch' }] })
    expect(sent.length).toBe(1)
    expect(sent[0].text).toContain('• WebFetch')
  })

  test('denials still post when the text send throws', async () => {
    const sent: Array<{ chatId: number; text: string }> = []
    let first = true
    const send = async (chatId: number, text: string) => {
      if (first) { first = false; throw new Error('smtp hiccup') }
      sent.push({ chatId, text })
      return 1
    }
    // The text send failing must not swallow the denial summary; the
    // helper surfaces the error only after attempting both messages.
    await expect(
      postTurnResult(send, 9, { text: 'hi', denials: [{ tool_name: 'Bash' }] }),
    ).rejects.toThrow('smtp hiccup')
    expect(sent.length).toBe(1)
    expect(sent[0].text).toContain('• Bash')
  })
})
