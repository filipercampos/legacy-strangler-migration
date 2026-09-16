export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidValueError extends DomainError {
  constructor(field: string, reason: string) {
    super('invalid_value', `${field}: ${reason}`);
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super('invalid_transition', `${entity} cannot go from ${from} to ${to}`);
  }
}

export class NotEntityOwnerError extends DomainError {
  constructor(entity: string, tenantId: string, owner: string) {
    super('not_entity_owner', `${entity} writes for tenant ${tenantId} are owned by ${owner}`);
  }
}
