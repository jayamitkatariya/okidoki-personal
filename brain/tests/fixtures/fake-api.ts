/** A fake Anthropic endpoint that records each request and answers with one tool call. */
export function fakeAPI(requests: Record<string, any>[], input: object): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const name = body.tools[0].name;
    return Response.json({ content: [{ type: "tool_use", id: "toolu_test", name, input }] });
  }) as unknown as typeof fetch;
}

/** The system prompt of a recorded request, whether it was sent as a string or as cached blocks. */
export function systemText(request: Record<string, any>): string {
  const system = request.system;
  if (typeof system === "string") return system;
  return (system as { text: string }[]).map((s) => s.text).join("\n");
}
