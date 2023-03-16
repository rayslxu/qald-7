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

const MAX_TRY = 2;
const RETRY_WAIT = 500;

function sleep(ms : number) {
    // eslint-disable-next-line no-promise-executor-return
    return new Promise((res) => setTimeout(res, ms));
}

export abstract class Linker {
    abstract run(id : string, utterance : string, thingtalk ?: string) : Promise<LinkerResult>;

    async saferun(id : string, utterance : string, thingtalk ?: string) : Promise<LinkerResult|null> {
        let tryCount = 0;
        while (tryCount < MAX_TRY) {
            try {
                return this.run(id, utterance, thingtalk);
            } catch(e) {
                console.log(`NED for example ${id} failed. Attempt No. ${tryCount+1}`);
                tryCount ++;
                if (tryCount === MAX_TRY)
                    console.warn(`NED for Example ${id} failed after ${MAX_TRY} attempts.`);
                else 
                    await sleep(RETRY_WAIT);
            }
        }
        return null;
    }

    async saferunAll(examples : Example[]) : Promise<LinkerResult[]> {
        const result = [];
        for (const example of examples) {
            const res = await this.saferun(example.id, example.sentence, example.thingtalk);
            if (res !== null)
                result.push(res);
        }
        return result;
    }
}