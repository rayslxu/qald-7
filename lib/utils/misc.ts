
import { Ast, Type } from 'thingtalk';

export function snakeCase(v : string) {
    return v.replace(/[() _-]+/g, '_').toLowerCase();
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