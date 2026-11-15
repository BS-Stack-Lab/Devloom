export const pointerKey = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
export const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
export function parseJson(bytes) {
  const text = bytes.toString('utf8');
  const value = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/gu) ?? [];
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '{' || token === '[') stack.push(token === '{' ? new Set() : null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ':') {
      const key = JSON.parse(token),
        keys = stack.at(-1);
      if (!keys || keys.has(key)) throw new Error('duplicate-json-key');
      keys.add(key);
    }
  }
  return value;
}
export function collectCatalog(inputs, { recordLimit = 50000 } = {}) {
  const records = [],
    diagnostics = [],
    deferred = [],
    sources = [];
  const issue = (code, extension, pointer) => diagnostics.push({ code, extension, pointer });
  const identities = new Set(),
    commandDeclarations = new Set(),
    settingIds = new Set(),
    submenuDeclarations = new Set();
  for (const input of inputs) {
    const { extension, manifest, nls, manifestSha256, nlsSha256, expected } = input;
    sources.push({ extension, manifestSha256, nlsSha256, expected });
    const contributes = manifest.contributes;
    if (!object(contributes)) {
      issue('contributes-shape', extension, '/contributes');
      continue;
    }
    const add = (kind, pointer, payload, id, context = {}) => {
      if (records.length >= recordLimit) {
        issue('record-limit', extension, pointer);
        return;
      }
      const key = `${extension}:${kind}:${pointer}`;
      if (identities.has(key)) issue('duplicate-record', extension, pointer);
      identities.add(key);
      const labels = [];
      const visit = (value, path) => {
        if (typeof value === 'string' && /^%[^%]+%$/u.test(value)) {
          const token = value.slice(1, -1),
            resolved = nls[token];
          labels.push({
            pointer: path,
            token: value,
            key: token,
            nlsPointer: `/${pointerKey(token)}`,
            value: typeof resolved === 'string' ? resolved : null,
            resolved: typeof resolved === 'string',
          });
        } else if (Array.isArray(value))
          value.forEach((child, index) => visit(child, `${path}/${index}`));
        else if (object(value))
          for (const [name, child] of Object.entries(value))
            visit(child, `${path}/${pointerKey(name)}`);
      };
      visit(payload, pointer);
      records.push({
        key,
        extension,
        kind,
        pointer,
        sourceOrdinal: records.length,
        sourceSha256: manifestSha256,
        nlsSha256,
        id,
        payload,
        labels,
        ...context,
      });
    };
    const commands = contributes.commands ?? [],
      commandIds = new Map();
    if (!Array.isArray(commands)) issue('commands-shape', extension, '/contributes/commands');
    else
      commands.forEach((command, index) => {
        const pointer = `/contributes/commands/${index}`;
        if (
          !object(command) ||
          typeof command.command !== 'string' ||
          !command.command ||
          !('title' in command)
        ) {
          issue('command-shape', extension, pointer);
          return;
        }
        if (commandDeclarations.has(command.command))
          issue('duplicate-command', extension, pointer);
        commandDeclarations.add(command.command);
        commandIds.set(command.command, `${extension}:command:${pointer}`);
        add('command', pointer, command, command.command);
      });
    const configuration = contributes.configuration ?? [];
    const configurations = Array.isArray(configuration) ? configuration : [configuration];
    configurations.forEach((config, index) => {
      const pointer = `/contributes/configuration${Array.isArray(configuration) ? `/${index}` : ''}`;
      if (!object(config) || !object(config.properties)) {
        issue('configuration-shape', extension, pointer);
        return;
      }
      for (const [id, setting] of Object.entries(config.properties)) {
        const path = `${pointer}/properties/${pointerKey(id)}`;
        if (!object(setting)) {
          issue('setting-shape', extension, path);
          continue;
        }
        if (settingIds.has(id)) issue('duplicate-setting', extension, path);
        settingIds.add(id);
        add('setting', path, setting, id);
      }
    });
    const submenus = contributes.submenus ?? [],
      submenuIds = new Map();
    if (!Array.isArray(submenus)) issue('submenus-shape', extension, '/contributes/submenus');
    else
      submenus.forEach((submenu, index) => {
        const pointer = `/contributes/submenus/${index}`;
        if (!object(submenu) || typeof submenu.id !== 'string' || !('label' in submenu)) {
          issue('submenu-shape', extension, pointer);
          return;
        }
        if (submenuDeclarations.has(submenu.id)) issue('duplicate-submenu', extension, pointer);
        submenuDeclarations.add(submenu.id);
        submenuIds.set(submenu.id, `${extension}:submenu:${pointer}`);
        add('submenu', pointer, submenu, submenu.id);
      });
    const menus = contributes.menus ?? {};
    if (!object(menus)) issue('menus-shape', extension, '/contributes/menus');
    else
      for (const [location, entries] of Object.entries(menus)) {
        const pointer = `/contributes/menus/${pointerKey(location)}`;
        if (!Array.isArray(entries)) {
          issue('menu-entries-shape', extension, pointer);
          continue;
        }
        entries.forEach((entry, index) => {
          const path = `${pointer}/${index}`;
          if (
            !object(entry) ||
            (!entry.command && !entry.submenu) ||
            (entry.command && entry.submenu) ||
            ['command', 'alt', 'submenu', 'when', 'group'].some(
              (name) => name in entry && typeof entry[name] !== 'string',
            )
          ) {
            issue('menu-shape', extension, path);
            return;
          }
          const references = [];
          for (const role of ['command', 'alt', 'submenu'])
            if (entry[role]) {
              const id = entry[role],
                target = (role === 'submenu' ? submenuIds : commandIds).get(id);
              if (role === 'submenu' && !target) issue('unresolved-submenu', extension, path);
              references.push({
                role,
                id,
                target: target ?? null,
                kind: target ? 'local' : role === 'submenu' ? 'unresolved' : 'external/core',
                reason: target
                  ? 'Exact declaration ID in this extension.'
                  : role === 'submenu'
                    ? 'No local submenu declaration.'
                    : 'Referenced command is not declared by this extension; ownership/runtime support not assessed.',
              });
            }
          add('menu', path, entry, null, { location, sourceIndex: index, references });
        });
      }
    for (const [name, payload] of Object.entries(contributes))
      if (!['commands', 'configuration', 'submenus', 'menus'].includes(name))
        deferred.push({
          extension,
          pointer: `/contributes/${pointerKey(name)}`,
          sourceSha256: manifestSha256,
          contribution: name,
          type: Array.isArray(payload) ? 'array' : typeof payload,
          count: Array.isArray(payload)
            ? payload.length
            : object(payload)
              ? Object.keys(payload).length
              : null,
          reason:
            'Outside command/setting/menu enumeration; requires separate source/runtime analysis in follow-up #13.',
          followUpPhase: 'P0',
        });
    for (const kind of ['command', 'setting', 'menu', 'submenu']) {
      const actual = records.filter(
        (record) => record.extension === extension && record.kind === kind,
      ).length;
      if (expected && actual !== expected[kind]) issue('expected-count-mismatch', extension, kind);
    }
  }
  return {
    records,
    sources,
    deferred,
    diagnostics,
    collectionCompleteness: diagnostics.length ? 'incomplete' : 'complete',
  };
}
