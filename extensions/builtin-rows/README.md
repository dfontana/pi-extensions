# builtin-rows

Draws pi's built-in `read`, `write`, `bash`, `grep`, `find`, and `ls` tools with the package's shared
compact row. Collapsed, each call is one line. Paths go last and are cut at the start, so the file
name stays visible:

```text
read ✓ offset=1 limit=5 ...rows/index.ts
bash ✓ timeout=10s sleep 3 && echo done
write ✓ 3 lines /tmp/notes.txt
```

Expanded (Ctrl+O, or `Enter` on a selected row), each row shows pi's own call and result rendering
under the title.

`edit` is left alone, since pi's edit renderer has its own diff preview.

pi has no render-only hook, so each tool is re-registered from pi's own definition factory, with the
options pi derives from settings (`images.autoResize`, `shellCommandPrefix`, `shellPath`). The expanded
view is loaded from pi's renderer module, which pi doesn't export. Because both are pi internals, the
override only applies on the pi version it was verified against. On any other version, the tools
keep pi's rendering and a warning is shown at startup. To re-verify, use the repo-local
`bump-pi-version` skill.

`grep`, `find`, and `ls` stay inactive unless enabled (for example with `--tools`).
