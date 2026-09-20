import { Injectable } from '@nestjs/common';
import { type LocalDate, localDate } from './domain/values';

/** Business calendar in America/Sao_Paulo: due dates are local, not UTC. */
@Injectable()
export class Clock {
  today(): LocalDate {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return localDate(parts);
  }
}
