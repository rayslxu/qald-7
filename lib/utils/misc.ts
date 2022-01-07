import { Ast, Type } from 'thingtalk';

export function snakeCase(v : string) {
    return v.trim().replace(/[() _-]+/g, '_').toLowerCase();
}

export function cleanName(v : string) {
    // replace u.s. to us
    v = v.replace(/u\.s\./g, 'us');
    // replace '(s)' to simply 's'
    v = v.replace(/\(s\)/g, 's');
    
    v = snakeCase(v);
    // remove accents
    v = v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    // replace any special tokens to underscore
    v = v.replace(/[^1-9a-zA-Z]/g, '_').replace(/__/g, '_');
    return v;
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

export function waitFinish(stream : NodeJS.WritableStream) : Promise<void> {
    return new Promise((resolve, reject) => {
        stream.once('finish', resolve);
        stream.on('error', reject);
    });
}