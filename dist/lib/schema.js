"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WikiSchema = void 0;
/**
 * A class to retrieve schema information from the schema
 */
class WikiSchema {
    constructor(schema) {
        this._tableMap = {};
        this._propertyMap = {};
        this._propertyTypeMap = {};
        for (const [qname, query] of Object.entries(schema.queries)) {
            const qid = (query.getImplementationAnnotation('wikidata_subject'))[0];
            this._tableMap[qid] = qname;
            for (const arg of query.iterateArguments()) {
                // skip id argument, and compound fields
                if (arg.name === 'id' || arg.name.includes('.'))
                    continue;
                const pid = arg.getImplementationAnnotation('wikidata_id');
                this._propertyMap[pid] = arg.name;
                this._propertyTypeMap[arg.name] = arg.type;
            }
        }
    }
    /**
     * @param qid QID of a domain
     * @returns the table name (cleaned label of the QID)
     */
    getTable(qid) {
        return this._tableMap[qid];
    }
    /**
     * @param pid PID of a property
     * @returns the property name (cleaned label of the PID)
     */
    getProperty(pid) {
        return this._propertyMap[pid];
    }
    /**
     * @param property the name of the property
     * @returns the entity type of the property
     */
    getPropertyType(property) {
        return this._propertyTypeMap[property];
    }
}
exports.WikiSchema = WikiSchema;
//# sourceMappingURL=schema.js.map