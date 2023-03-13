export interface Example {
    id : string,
    sentence : string,
    thingtalk : string,
    entities ?: Entity[],
    relation ?: Relation[]
}

export interface LinkerResult {
    entities : Entity[];
    relations : Relation[];
}

export interface Relation {
    id : string,
    label : string,
    type : 'relation'
}

export interface Entity {
    id : string,
    label : string,
    domain : string|null,
    type : 'entity'
}

export abstract class Linker {
    abstract run(id : string, utterance : string, thingtalk ?: string) : Promise<LinkerResult>;
}