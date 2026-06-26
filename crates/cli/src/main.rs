use clap::{Parser, Subcommand};

mod bind;
mod omp;
mod schedule;
mod thread;

#[derive(Parser)]
#[command(name = "pico", version, about = "pico command-line interface")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Omp(omp::OmpArgs),
    Bind(bind::BindArgs),
    #[command(subcommand)]
    Schedule(schedule::ScheduleCommand),
}

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;
    let cli = Cli::parse();
    match cli.command {
        Command::Omp(args) => omp::run(args).await,
        Command::Bind(args) => bind::run(args).await,
        Command::Schedule(cmd) => schedule::run(cmd).await,
    }
}
