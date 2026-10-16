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

It only changes how calls are drawn. A `pi.registerToolRenderer` resolver wraps the renderers pi
would otherwise use, so the tools, their settings, and which ones are active stay pi's. It uses no pi
internals and doesn't depend on the pi version. If pi ever stops providing a call and result
renderer for one of these tools, or draws it in a custom shell, that tool keeps pi's rendering. If
pi's renderer throws, the row shows only its title.
