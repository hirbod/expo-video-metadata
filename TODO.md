# TODO

## Expose full codec parameter strings

The public `codec` and `audioCodec` fields are currently normalized to codec family names for platform parity:

- `mp4a.40.2` -> `aac`
- `avc` -> `avc1`
- `hevc` -> `hev1`

This keeps web, iOS, and Android easier to compare. Mediabunny can expose richer codec parameter strings on web, such as `mp4a.40.2` or `avc1.640028`, which may be useful for compatibility checks and debugging.

Revisit adding separate fields in a future minor release:

```ts
codec: "avc1";
codecString: "avc1.640028";
audioCodec: "aac";
audioCodecString: "mp4a.40.2";
```

Do not replace the existing normalized fields without a breaking change.
