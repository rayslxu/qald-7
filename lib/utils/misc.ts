
import { Ast, Type } from 'thingtalk';

export function snakeCase(v : string) {
    return v.trim().replace(/[() _-]+/g, '_').toLowerCase();
}

export function cleanName(v : string) {
    v = snakeCase(v);
    // remove accents
    v = v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    // replace u.s. to us
    v = v.replace('u.s.', 'us');
    // replace any special tokens to underscore
    v = v.replace(/[^1-9a-zA-Z]/g, '_').replace(/__/g, '_');
    return v;
}

export function waitFinish(stream : NodeJS.WritableStream) : Promise<void> {
    return new Promise((resolve, reject) => {
        stream.once('finish', resolve);
        stream.on('error', reject);
    });
}

export function idArgument(entityType : string) : Ast.ArgumentDef {
    return new Ast.ArgumentDef(
        null,
        Ast.ArgDirection.OUT,
        'id', 
        new Type.Entity(`org.wikidata:${entityType}`),
        { nl: { canonical: { base: ['name'], passive_verb: ['named', 'called'] } } }
    );
}