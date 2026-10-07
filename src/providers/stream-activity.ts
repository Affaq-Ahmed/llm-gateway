export function observeResponseBytes(
  fetchImpl: typeof fetch,
  onBytes: () => void,
): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.body === null) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        onBytes();
        controller.enqueue(result.value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
